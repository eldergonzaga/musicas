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
  
  console.log(`[Stream] Requesting ${fileId}${range ? ` with range ${range}` : ''}`);

  try {
    const drive = getDriveClient(token);

    // 1. Buscar Metadados primeiro para saber o nome e o tipo real do arquivo
    console.log(`[Stream] Fetching metadata for ${fileId}`);
    const metadataResponse = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType',
      supportsAllDrives: true
    });
    
    const fileName = metadataResponse.data.name || '';
    let mimeType = metadataResponse.data.mimeType || 'audio/mpeg';

    // 2. Corrigir MIME Type para Dispositivos Móveis (crucial para iOS)
    if (mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream' || !mimeType) {
      const ext = path.extname(fileName).toLowerCase();
      if (ext === '.mp3') mimeType = 'audio/mpeg';
      else if (ext === '.m4a') mimeType = 'audio/mp4';
      else if (ext === '.wav') mimeType = 'audio/wav';
      else if (ext === '.ogg') mimeType = 'audio/ogg';
      else if (ext === '.aac') mimeType = 'audio/aac';
      else mimeType = 'audio/mpeg'; // Default fallback
    }

    console.log(`[Stream] Real MIME detected: ${mimeType} for file: ${fileName}`);

    // 3. Solicitar a mídia ao Google
    const googleResponse = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true, acknowledgeAbuse: true },
      { 
        responseType: 'stream',
        headers: range ? { Range: range } : {} 
      }
    );

    const gContentType = (googleResponse.headers['content-type'] || '').toLowerCase();
    
    // Se o Google devolver HTML, é sinal de erro ou aviso de vírus
    if (gContentType.includes('text/html')) {
       console.error(`[Stream Error] Google returned HTML for ${fileId}. Likely a virus scan warning.`);
       return res.status(403).send('Arquivo muito grande ou protegido. O Google Drive exige confirmação manual para este download.');
    }

    // 4. Configurar Cabeçalhos Rigorosos para Mobile
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache moderado ajuda no streaming estável
    
    const headersToCopy = [
      'content-length',
      'content-range',
      'last-modified',
      'etag'
    ];

    Object.entries(googleResponse.headers).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (headersToCopy.includes(lowerKey)) {
        res.setHeader(key, value as string);
      }
    });

    // Importante: Remover o header de transferência em pedaços se houver content-length definido
    if (googleResponse.headers['content-length']) {
      res.removeHeader('Transfer-Encoding');
    }

    res.status(googleResponse.status);
    console.log(`[Stream] Handshaking with mobile: ${googleResponse.status} | Bytes: ${googleResponse.headers['content-length']}`);

    // 5. Transmitir os dados e gerenciar erros de stream
    googleResponse.data.pipe(res);

    googleResponse.data.on('error', (err) => {
      console.error(`[Stream Data Error] ${fileId}:`, err.message);
      if (!res.headersSent) res.status(500).end();
    });

    req.on('close', () => {
      if (googleResponse.data.destroy) googleResponse.data.destroy();
    });

  } catch (error: any) {
    console.error(`[Stream Catch Error] ${fileId}:`, error.message);
    if (!res.headersSent) {
      const status = error.response?.status || 500;
      res.status(status).send(error.message || 'Falha ao buscar áudio no Drive.');
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
