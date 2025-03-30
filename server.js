import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import WebTorrent from 'webtorrent';
import parseTorrent from 'parse-torrent';

const app = new Hono();
// const client = new WebTorrent();
const client = new WebTorrent({
    dht: {
        host: '0.0.0.0', // Escuchar en todas las interfaces
        port: 6881
    },
    tracker: {
        udp: false, // Oracle bloquea UDP para trackers
        ws: true    // Usar WebSocket trackers
    }
});
const port = process.env.PORT || 1111;

// Configuración Avanzada
const ACTIVE_CONNECTIONS = new Map();
const ACTIVE_CONECTIONS_CLEANUP_TIME = 5000;
const PEERS_TIMEOUT = 60000;
const CHUNK_SIZE = 5 * 1024 * 1024;
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

function enhanceMagnet(magnet) {
    const parsed = parseTorrent(magnet);
    parsed.tr = [...new Set([...TRACKERS, ...(parsed.tr || [])])];
    return parseTorrent.toMagnetURI(parsed);
}

app.get('/stream', async (c) => {
    const connectionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let readStream = null;

    try {
        const magnet = c.req.query('magnet');
        if (!magnet) throw new Error('Magnet link requerido');

        const enhancedMagnet = enhanceMagnet(magnet);
        const parsed = parseTorrent(enhancedMagnet);
        const infoHash = parsed.infoHash.toUpperCase();

        const torrent = client.get(infoHash) || client.add(enhancedMagnet, {
            destroyStoreOnDestroy: true,
            strategy: 'sequential',
            dht: false
        });

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

        const videoFile = torrent.files.find(f => 
            /\.(mp4|mkv|webm|avi)$/i.test(f.name)
        ) || torrent.files[0];

        if (!videoFile) throw new Error('Archivo de video no encontrado');

        const fileSize = videoFile.length;
        const headers = {
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp4',
            'Content-Length': fileSize.toString(),
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET'
        };

        let start = 0;
        let end = fileSize - 1;
        const rangeHeader = c.req.header('range');

        if (rangeHeader) {
            const range = rangeHeader.replace(/bytes=/, '');
            [start, end] = range.split('-').map(Number);

            if (start >= fileSize || end >= fileSize) {
                return c.text('Range Not Satisfiable', 416, {
                    headers: { 'Content-Range': `bytes */${fileSize}` }
                });
            }

            end = end || Math.min(start + CHUNK_SIZE, fileSize - 1);
            headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
            headers['Content-Length'] = (end - start + 1).toString();
        }

        readStream = videoFile.createReadStream({ start, end });
        ACTIVE_CONNECTIONS.set(connectionId, { readStream });

        const cleanUp = (error = null) => {
            if (readStream && !readStream.destroyed) {
                readStream.destroy(error || undefined);
                ACTIVE_CONNECTIONS.delete(connectionId);
            }
        };

        c.req.raw.signal.addEventListener('abort', () => cleanUp(new Error('Client aborted')));

        return new Response(
            new ReadableStream({
                start(controller) {
                    readStream.on('data', (chunk) => controller.enqueue(chunk));
                    readStream.on('end', () => controller.close());
                    readStream.on('error', (err) => {
                        cleanUp(err);
                        controller.error(err);
                    });
                },
                cancel() {
                    cleanUp();
                }
            }),
            {
                status: rangeHeader ? 206 : 200,
                headers: headers
            }
        );

    } catch (error) {
        console.error(`[${connectionId}] Error:`, error.message);
        if (readStream && !readStream.destroyed) readStream.destroy();
        ACTIVE_CONNECTIONS.delete(connectionId);
        
        return c.text(
            error.message.includes('Timeout') || error.message.includes('Client aborted') 
                ? 'Conexión interrumpida' 
                : 'Error en el servidor',
            error.message.includes('Timeout') ? 504 : 500
        );
    }
});

app.get('/health', async (c) => {
    return c.text('OK', 200);
});

// Limpieza de conexiones
setInterval(() => {
    ACTIVE_CONNECTIONS.forEach((conn, id) => {
        if (conn.readStream.destroyed || conn.readStream.closed) {
            conn.readStream.destroy();
            ACTIVE_CONNECTIONS.delete(id);
        }
    });
}, ACTIVE_CONECTIONS_CLEANUP_TIME);

serve({
    fetch: app.fetch,
    port
}, () => {
    console.log(`Servidor escuchando en el puerto ${port}`);
    console.log(`Conexiones activas: ${ACTIVE_CONNECTIONS.size}`);
});