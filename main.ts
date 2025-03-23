import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import WebTorrent from "https://esm.sh/webtorrent@1.8.0";

const client = new WebTorrent({ dht: false, webSeeds: false });
const torrentCache = new Map<string, { torrent: any; file: any; timestamp: number }>();
const CACHE_TTL = 300_000; // 5 minutos
const BLOCKED_HASHES = new Set(["HASH_PROHIBIDO_1", "HASH_PROHIBIDO_2"]);

async function getTorrent(magnet: string) {
  // Verificar cache
  if (torrentCache.has(magnet)) {
    const cached = torrentCache.get(magnet)!;
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached;
    }
    torrentCache.delete(magnet);
  }

  // Verificar hash bloqueado
  const infoHash = magnet.match(/xt=urn:btih:([^&]+)/i)?.[1]?.toUpperCase();
  if (infoHash && BLOCKED_HASHES.has(infoHash)) {
    throw new Error("Contenido bloqueado por derechos de autor");
  }

  const torrent = client.add(magnet);
  const file = await new Promise<any>((resolve, reject) => {
    torrent.on("ready", () => {
      const videoFile = torrent.files.find((f: any) => 
        /\.(mp4|mkv|webm|avi)$/i.test(f.name)
      ) || torrent.files[0];
      resolve(videoFile);
    });
    
    torrent.on("error", reject);
    
    setTimeout(() => {
      reject(new Error("Timeout: No se encontraron peers en 8 segundos"));
    }, 8000);
  });

  // Almacenar en cache
  torrentCache.set(magnet, { torrent, file, timestamp: Date.now() });
  return { torrent, file };
}

serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const magnet = url.searchParams.get("magnet");
    
    // Validación básica
    if (!magnet?.startsWith("magnet:?")) {
      return new Response("Magnet link inválido", { 
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // Obtener torrent (con cache)
    const { file } = await getTorrent(magnet);
    
    // Manejar range requests
    const range = req.headers.get("range");
    const headers = new Headers({
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${CACHE_TTL / 1000}`
    });

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : file.length - 1;
      
      if (start >= file.length || end >= file.length) {
        headers.set("Content-Range", `bytes */${file.length}`);
        return new Response(null, { 
          status: 416, 
          headers 
        });
      }
      
      headers.set("Content-Range", `bytes ${start}-${end}/${file.length}`);
      headers.set("Content-Length", (end - start + 1).toString());
      
      return new Response(
        file.createReadStream({ start, end }),
        { status: 206, headers }
      );
    }

    // Stream completo
    headers.set("Content-Length", file.length.toString());
    return new Response(file.createReadStream(), { headers });
    
  } catch (error) {
    // Limpiar cache en caso de error
    if (error.message.includes("blockeado")) {
      return new Response(error.message, { 
        status: 451, // Unavailable For Legal Reasons
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
    
    return new Response(error.message, { 
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
});