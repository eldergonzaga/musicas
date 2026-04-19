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

// API Routes
app.head('/api/drive/stream/:fileId', async (req, res) => {
  const token = req.cookies.drive_token;
  if (!token) return res.status(401).end();

  try {
    const drive = getDriveClient(token);
    const metadata = await drive.files.get({
      fileId: req.params.fileId,
      fields: 'id, name, mimeType, size',
      supportsAllDrives: true
    });
    
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', metadata.data.mimeType || 'audio/mpeg');
    res.setHeader('Content-Length', metadata.data.size || '0');
    res.status(200).end();
  } catch (error) {
    res.status(500).end();
  }
});

app.get('/api/drive/stream/:fileId', async (req, res) => {
  const token = req.cookies.drive_token;
  if (!token) {
    console.error('[Stream] Missing auth cookie for mobile request');
    return res.status(401).send('Authentication required');
  }

  const fileId = req.params.fileId;
  const range = req.headers.range;
  
  console.log(`[Stream] Mobile Request | Range: ${range || 'None'} | ID: ${fileId}`);

  try {
    const drive = getDriveClient(token);

    // 1. Obter metadados primeiro (necessário para Content-Length total)
    const meta = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, size',
      supportsAllDrives: true
    });

    const totalSize = parseInt(meta.data.size || '0');
    let mimeType = meta.data.mimeType || 'audio/mpeg';
    
    // Correção de MIME para Mobile
    if (mimeType.includes('octet-stream')) {
      const ext = path.extname(meta.data.name || '').toLowerCase();
      if (ext === '.mp3') mimeType = 'audio/mpeg';
      else if (ext === '.m4a') mimeType = 'audio/mp4';
      else if (ext === '.wav') mimeType = 'audio/wav';
    }

    // 2. Desabilitar Buffer do Nginx (Render/Cloud Run)
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);

    // 3. Configurar a requisição para o Google
    const googleResponse = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true, acknowledgeAbuse: true },
      { 
        responseType: 'stream',
        headers: range ? { Range: range } : {} 
      }
    );

    // 4. Repassar Status e Headers de Range
    res.status(googleResponse.status);
    
    if (googleResponse.headers['content-range']) {
      res.setHeader('Content-Range', googleResponse.headers['content-range']);
    }
    if (googleResponse.headers['content-length']) {
      res.setHeader('Content-Length', googleResponse.headers['content-length']);
    }

    console.log(`[Stream] Proxying Google: ${googleResponse.status} | Range: ${res.getHeader('Content-Range')}`);

    // 5. Pipe do stream
    googleResponse.data.pipe(res);

    googleResponse.data.on('error', (err) => {
      console.error(`[Stream Error] Data flow broken for ${fileId}:`, err.message);
      res.end();
    });

    req.on('close', () => {
      if (googleResponse.data.destroy) googleResponse.data.destroy();
    });

  } catch (error: any) {
    console.error(`[Stream Error] Global catch for ${fileId}:`, error.message);
    if (!res.headersSent) {
      if (error.response?.status === 403) {
        return res.status(403).send('Google Drive bloqueou o streaming direto (confirmacao necessaria).');
      }
      res.status(500).send('Erro interno no servidor de áudio.');
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
