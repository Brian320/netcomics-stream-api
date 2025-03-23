import express from 'express';
import WebTorrent from 'webtorrent';
import parseTorrent from 'parse-torrent';
import { pipeline } from 'node:stream/promises';

const app = express();
const client = new WebTorrent();
const port = process.env.PORT || 1111;

// Configuración Avanzada
const ACTIVE_CONNECTIONS = new Map();
const ACTIVE_CONECTIONS_CLEANUP_TIME = 5000;
const PEERS_TIMEOUT = 60000;
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
const TRACKERS = [
    'wss://tracker.openwebtorrent.com',
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.leechers-paradise.org:6969/announce',
    'udp://tracker.coppersurfer.tk:6969/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker.internetwarriors.net:1337/announce',
    'udp://tracker.pirateparty.gr:6969/announce',
    'udp://tracker.tiny-vps.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
];

// Función para mejorar magnet links
function enhanceMagnet(magnet) {
  const parsed = parseTorrent(magnet);
  parsed.tr = [...new Set([...TRACKERS, ...(parsed.tr || [])])];
  return parseTorrent.toMagnetURI(parsed);
}

app.get('/stream', async (req, res) => {
  const connectionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let readStream = null;

  try {
    // 1. Validar y mejorar magnet link
    const magnet = req.query.magnet;
    if (!magnet) throw new Error('Magnet link requerido');
    
    const enhancedMagnet = enhanceMagnet(magnet);
    const parsed = parseTorrent(enhancedMagnet);
    const infoHash = parsed.infoHash.toUpperCase();

    // 2. Gestionar torrent
    const torrent = client.get(infoHash) || client.add(enhancedMagnet, {
      destroyStoreOnDestroy: true,
      strategy: 'sequential',
      dht: false // Mejor rendimiento para streaming
    });

    // 3. Esperar metadata con control de estado
    await new Promise((resolve, reject) => {
      if (torrent.ready) return resolve();
      
      torrent.once('ready', resolve);
      torrent.once('error', reject);
      
      setTimeout(() => {
        torrent.removeListener('ready', resolve);
        torrent.removeListener('error', reject);
        reject(new Error('Timeout: No se encontraron peers'));
      }, PEERS_TIMEOUT);
    });

    // 4. Seleccionar archivo de video
    const videoFile = torrent.files.find(f => 
      /\.(mp4|mkv|webm|avi)$/i.test(f.name)
    ) || torrent.files[0];

    if (!videoFile) throw new Error('Archivo de video no encontrado');

    // 5. Configurar headers dinámicos
    const fileSize = videoFile.length;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    // 6. Manejar Range requests con validación
    let start = 0;
    let end = fileSize - 1;
    
    if (req.headers.range) {
      const range = req.headers.range.replace(/bytes=/, '');
      [start, end] = range.split('-').map(Number);
      
      // Validar rangos
      if (start >= fileSize || end >= fileSize) {
        res.status(416).header('Content-Range', `bytes */${fileSize}`).end();
        return;
      }
      
      end = end || Math.min(start + CHUNK_SIZE, fileSize - 1);
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': end - start + 1
      });
    }

    // 7. Crear stream con gestión de ciclo de vida
    readStream = videoFile.createReadStream({ start, end });
    ACTIVE_CONNECTIONS.set(connectionId, { readStream, res });

    // 8. Manejo avanzado de cierre
    const cleanUp = () => {
      if (readStream && !readStream.destroyed) {
        readStream.destroy();
        ACTIVE_CONNECTIONS.delete(connectionId);
      }
    };

    req.on('close', cleanUp);
    res.on('finish', cleanUp);

    // 9. Pipeline seguro con manejo de errores
    await pipeline(
      readStream,
      res
    ).catch(err => {
      if (!err.message.includes('premature close')) {
        throw err;
      }
    });

  } catch (error) {
    console.error(`[${connectionId}] Error:`, error.message);
    if (!res.headersSent) {
      res.status(500).send(
        error.message.includes('Timeout') ? 
        'El contenido no está disponible' : 
        'Error en el servidor'
      );
    }
    if (readStream && !readStream.destroyed) readStream.destroy();
    ACTIVE_CONNECTIONS.delete(connectionId);
  }
});

// Limpieza agresiva de conexiones
setInterval(() => {
  ACTIVE_CONNECTIONS.forEach((conn, id) => {
    if (conn.res.destroyed || conn.readStream.destroyed) {
      conn.readStream.destroy();
      ACTIVE_CONNECTIONS.delete(id);
    }
  });
}, ACTIVE_CONECTIONS_CLEANUP_TIME); // Cada 5 segundos

app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto ${port}`);
  console.log(`Conexiones activas: ${ACTIVE_CONNECTIONS.size}`);
});