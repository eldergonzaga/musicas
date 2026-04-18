import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { google } from 'googleapis';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import * as musicMetadata from 'music-metadata';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cookieParser());
app.use(express.json());

// Validation check
const checkConfig = () => {
  const missing = [];
  if (!process.env.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
  if (!process.env.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
  if (!process.env.APP_URL) missing.push('APP_URL');
  
  if (missing.length > 0) {
    console.error('❌ MISSING CONFIGURATION:', missing.join(', '));
    console.error('Please add these to the Secrets panel in AI Studio Settings.');
  }
};

checkConfig();

// Google OAuth Configuration
const getRedirectUri = () => {
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  return `${baseUrl.replace(/\/$/, '')}/auth/callback`;
};

const REDIRECT_URI = getRedirectUri();
console.log('👉 COPY THIS TO "Authorized redirect URIs" in Google Cloud:');
console.log(REDIRECT_URI);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// API Routes
app.get('/api/auth/url', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.json({ url: authUrl });
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    res.cookie('drive_token', JSON.stringify(tokens), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth Error:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/api/auth/status', (req, res) => {
  const token = req.cookies.drive_token;
  res.json({ isAuthenticated: !!token });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('drive_token');
  res.json({ success: true });
});

const getDriveClient = (token: string) => {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials(JSON.parse(token));
  return google.drive({ version: 'v3', auth: client });
};

app.get('/api/drive/list/:folderId?', async (req, res) => {
  const token = req.cookies.drive_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const folderId = req.params.folderId || 'root';
  const drive = getDriveClient(token);

  try {
    const q = folderId === 'sharedWithMe' 
      ? 'sharedWithMe = true and trashed = false'
      : `'${folderId}' in parents and trashed = false`;

    const response = await drive.files.list({
      q: q,
      fields: 'files(id, name, mimeType, thumbnailLink, size, modifiedTime)',
      orderBy: 'folder,name',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    res.json(response.data.files || []);
  } catch (error: any) {
    console.error('Drive List Error:', error);
    // Return the actual error message from Google to help debugging
    const message = error.errors?.[0]?.message || error.message || 'Unknown Drive error';
    res.status(500).json({ error: message });
  }
});

app.get('/api/drive/cover/:fileId', async (req, res) => {
  const token = req.cookies.drive_token;
  const fileId = req.params.fileId;

  if (!token) {
    console.log(`[Cover] No token for ${fileId}, using placeholder`);
    return res.redirect(`https://picsum.photos/seed/${fileId}/800/800`);
  }

  try {
    console.log(`[Cover] Starting extraction for ${fileId}...`);
    const drive = getDriveClient(token);
    
    const googleResponse = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    // Timeout for metadata parsing to avoid hanging
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
        console.log(`[Cover] Timing out extraction for ${fileId}`);
        abortController.abort();
        googleResponse.data.destroy();
    }, 8000);

    try {
      console.log(`[Cover] Streaming metadata for ${fileId}...`);
      const metadata = await musicMetadata.parseStream(googleResponse.data, {
        size: parseInt(googleResponse.headers['content-length'] || '0')
      });

      clearTimeout(timeout);

      if (metadata.common.picture && metadata.common.picture.length > 0) {
        const picture = metadata.common.picture[0];
        console.log(`[Cover] Found art for ${fileId}: ${picture.format} (${picture.data.length} bytes)`);
        res.setHeader('Content-Type', picture.format || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(picture.data);
      } else {
        console.log(`[Cover] No art found in metadata for ${fileId}`);
        res.redirect(`https://picsum.photos/seed/${fileId}/800/800`);
      }
    } catch (parseError: any) {
      clearTimeout(timeout);
      console.error(`[Cover Parse Error] ${fileId}:`, parseError.message);
      res.redirect(`https://picsum.photos/seed/${fileId}/800/800`);
    } finally {
      googleResponse.data.destroy();
    }

  } catch (error: any) {
    console.error(`[Cover Request Error] ${fileId}:`, error.message);
    res.redirect(`https://picsum.photos/seed/${fileId}/800/800`);
  }
});

app.get('/api/drive/stream/:fileId', async (req, res) => {
  const token = req.cookies.drive_token;
  if (!token) return res.status(401).send('Not authenticated');

  const fileId = req.params.fileId;
  const range = req.headers.range;

  try {
    const drive = getDriveClient(token);
    
    // Configurar a requisição de mídia usando o cliente oficial
    const googleResponse = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true, acknowledgeAbuse: true },
      { 
        responseType: 'stream',
        headers: range ? { Range: range } : {} 
      }
    );

    // 3. Repassar os cabeçalhos de áudio do Google para o navegador
    res.status(googleResponse.status);
    
    // Garantir que o navegador saiba que suportamos ranges
    res.setHeader('Accept-Ranges', 'bytes');
    
    const headersToCopy = [
      'content-type',
      'content-length',
      'content-range',
      'cache-control'
    ];

    Object.entries(googleResponse.headers).forEach(([key, value]) => {
      if (headersToCopy.includes(key.toLowerCase())) {
        res.setHeader(key, value as string);
      }
    });

    // Garantir que o navegador saiba que é um áudio
    const mimeType = googleResponse.headers['content-type'] || 'audio/mpeg';
    res.setHeader('Content-Type', mimeType);

    // 4. Transmitir os dados (Pipe)
    googleResponse.data.pipe(res);

    // Fechar o stream se o usuário fechar a aba ou parar a música
    req.on('close', () => {
      if (googleResponse.data.destroy) googleResponse.data.destroy();
    });

  } catch (error: any) {
    console.error('[Stream Critical Error]:', error.message);
    // Se o erro for "Not Found" ou "Forbidden", avisar o console
    if (error.response) {
      console.error('[Google Response Error]:', error.response.status, error.response.data);
    }
    
    if (!res.headersSent) {
      res.status(500).send('Streaming failed');
    }
  }
});

// Vite Integration
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
