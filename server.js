import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const HUDHUD_LINK_BASE = "https://l.hudhud.sa/l/";

// Hudhud short links (l.hudhud.sa/l/<id>) use a geohash of the coordinates as
// the id — precision 12, standard base32. Building it here lets us produce the
// same short-link format Hudhud's app mints, with no API call.
const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function geohashEncode(lat, lng, precision = 12) {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = "";
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lng >= mid) {
        idx = idx * 2 + 1;
        lonMin = mid;
      } else {
        idx = idx * 2;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = idx * 2 + 1;
        latMin = mid;
      } else {
        idx = idx * 2;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      geohash += GEOHASH_BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return geohash;
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

// Validate a lat/lng pair is within geographic bounds.
function validCoords(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

function decodeUrl(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

// Exact location encoded directly in a Google Maps URL (the place pin or an
// explicit query coordinate). Excludes @lat,lng, which is only the viewport.
function preciseCoordsFromUrl(url) {
  const decoded = decodeUrl(url);
  const patterns = [
    // !3d24.77!4d46.72  (place data block — the real pin)
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    // ?q=24.77,46.72  / ll= / query= / daddr= / sll= / loc:
    /(?:[?&](?:q|ll|query|daddr|saddr|sll|destination)=)(?:loc:)?(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
  ];
  for (const re of patterns) {
    const m = decoded.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (validCoords(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

// The @lat,lng viewport center — correct for plain map links that have no
// place pin, but only used as a fallback since it can be offset from a place.
function viewportCoordsFromUrl(url) {
  const m = decodeUrl(url).match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (validCoords(lat, lng)) return { lat, lng };
  }
  return null;
}

// Google place links carry a feature id (ftid=0x..:0xCID) but no coordinates.
// The CID resolves to the exact pin via the embed endpoint.
function cidFromUrl(url) {
  const decoded = decodeUrl(url);
  let m = decoded.match(/[?&]cid=(\d{5,})/);
  if (m) return m[1];
  // ftid / !1s forms both end in :0x<hex CID>
  m = decoded.match(/(?:ftid=|!1s)0x[0-9a-f]+:0x([0-9a-f]+)/i);
  if (m) return BigInt("0x" + m[1]).toString();
  return null;
}

// Resolve a place CID to its exact pin. The embed page encodes the camera as
// [[[alt, lng, lat], ...]] — note lng precedes lat.
async function pinFromCid(cid) {
  const res = await fetch(
    `https://maps.google.com/maps?cid=${cid}&output=embed`,
    { redirect: "follow", headers: BROWSER_HEADERS },
  );
  const html = await res.text();
  const m = html.match(
    /\[\[\[-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]/,
  );
  if (m) {
    let lng = parseFloat(m[1]);
    let lat = parseFloat(m[2]);
    if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) [lat, lng] = [lng, lat];
    if (validCoords(lat, lng)) return { lat, lng };
  }
  return null;
}

// Fall back to scraping coordinates from the Google Maps page HTML.
// Only patterns with a known lat,lng order are used. The static-map
// center= is the viewport, so it is the last resort.
function coordsFromHtml(html) {
  const patterns = [
    // !3d24.77!4d46.72  (place data block: 3d=lat, 4d=lng)
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    // [null,null,24.77,46.72] inside the embedded app state
    /\[null,null,(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/,
    // og:image / static map: center=24.77%2C46.72  (viewport — last)
    /center=(-?\d+\.\d+)(?:%2C|,)(-?\d+\.\d+)/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (validCoords(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

async function resolveCoords(inputUrl) {
  // 1. Exact coordinates already present in the pasted URL.
  let coords = preciseCoordsFromUrl(inputUrl);
  if (coords) return { ...coords, finalUrl: inputUrl, source: "input-url" };

  // 2. Place id in the pasted URL -> resolve the exact pin via CID.
  let cid = cidFromUrl(inputUrl);
  if (cid) {
    coords = await pinFromCid(cid);
    if (coords) return { ...coords, finalUrl: inputUrl, source: "cid-pin" };
  }

  // 3. Follow redirects (expands maps.app.goo.gl short links).
  const res = await fetch(inputUrl, {
    redirect: "follow",
    headers: BROWSER_HEADERS,
  });
  const finalUrl = res.url || inputUrl;

  // 4. Place id in the expanded URL -> exact pin (the common short-link path).
  cid = cidFromUrl(finalUrl);
  if (cid) {
    coords = await pinFromCid(cid);
    if (coords) return { ...coords, finalUrl, source: "cid-pin" };
  }

  // 5. Exact coordinates in the expanded URL.
  coords = preciseCoordsFromUrl(finalUrl);
  if (coords) return { ...coords, finalUrl, source: "expanded-url" };

  // 6. Scrape the page HTML (place pin patterns first, viewport last).
  const html = await res.text();
  coords = coordsFromHtml(html);
  if (coords) return { ...coords, finalUrl, source: "page-html" };

  // 7. Viewport center — only if nothing more precise was found.
  coords = viewportCoordsFromUrl(finalUrl) || viewportCoordsFromUrl(inputUrl);
  if (coords) return { ...coords, finalUrl, source: "viewport" };

  return { finalUrl, source: "not-found" };
}

app.post("/api/convert", async (req, res) => {
  const { url } = req.body || {};

  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
    return res
      .status(400)
      .json({ error: "Please provide a valid Google Maps URL (http/https)." });
  }

  try {
    const result = await resolveCoords(url.trim());

    if (!validCoords(result.lat, result.lng)) {
      return res.status(422).json({
        error:
          "Could not find coordinates for this link. Try a link that includes a point on the map (e.g. with @lat,lng in the URL).",
        finalUrl: result.finalUrl,
      });
    }

    const hudhudUrl = `${HUDHUD_LINK_BASE}${geohashEncode(result.lat, result.lng)}`;
    return res.json({
      lat: result.lat,
      lng: result.lng,
      hudhudUrl,
      finalUrl: result.finalUrl,
      source: result.source,
    });
  } catch (err) {
    return res
      .status(502)
      .json({ error: `Failed to resolve link: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`Google Maps -> Hudhud converter running on http://localhost:${PORT}`);
});
