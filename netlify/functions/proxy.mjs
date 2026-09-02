// /netlify/functions/proxy.mjs - Netlify Function (ES Module) - patched binary-safe
// 修正：image/video/audio 二進位內容不再用純文字 body 返回，避免破圖

import fetch from 'node-fetch';
import { URL } from 'url';
import crypto from 'crypto';

const DEBUG_ENABLED = process.env.DEBUG === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10);
const MAX_RECURSION = parseInt(process.env.MAX_RECURSION || '5', 10);

let USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];
try {
    const agentsJsonString = process.env.USER_AGENTS_JSON;
    if (agentsJsonString) {
        const parsedAgents = JSON.parse(agentsJsonString);
        if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
            USER_AGENTS = parsedAgents;
        }
    }
} catch (e) {
    console.error(`[Proxy Log Netlify] Error parsing USER_AGENTS_JSON environment variable: ${e.message}. Using default user agents.`);
}

const FILTER_DISCONTINUITY = false;

function logDebug(message) {
    if (DEBUG_ENABLED) {
        console.log(`[Proxy Log Netlify] ${message}`);
    }
}

function getTargetUrlFromPath(encodedPath) {
    if (!encodedPath) { logDebug("getTargetUrlFromPath received empty path."); return null; }
    try {
        const decodedUrl = decodeURIComponent(encodedPath);
        if (decodedUrl.match(/^https?:\/\/.+/i)) { return decodedUrl; }
        else {
            logDebug(`Invalid decoded URL format: ${decodedUrl}`);
            if (encodedPath.match(/^https?:\/\/.+/i)) { logDebug(`Warning: Path was not encoded but looks like URL: ${encodedPath}`); return encodedPath; }
            return null;
        }
    } catch (e) { logDebug(`Error decoding target URL: ${encodedPath} - ${e.message}`); return null; }
}

function getBaseUrl(urlStr) {
    if (!urlStr) return '';
    try {
        const parsedUrl = new URL(urlStr);
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
        if (pathSegments.length <= 1) { return `${parsedUrl.origin}/`; }
        pathSegments.pop(); return `${parsedUrl.origin}/${pathSegments.join('/')}/`;
    } catch (e) {
        logDebug(`Getting BaseUrl failed for "${urlStr}": ${e.message}`);
        const lastSlashIndex = urlStr.lastIndexOf('/');
        if (lastSlashIndex > urlStr.indexOf('://') + 2) { return urlStr.substring(0, lastSlashIndex + 1); }
        return urlStr + '/';
    }
}

function resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return ''; if (relativeUrl.match(/^https?:\/\/.+/i)) { return relativeUrl; } if (!baseUrl) return relativeUrl;
    try { return new URL(relativeUrl, baseUrl).toString(); }
    catch (e) {
        logDebug(`URL resolution failed: base="${baseUrl}", relative="${relativeUrl}". Error: ${e.message}`);
        if (relativeUrl.startsWith('/')) { try { const baseOrigin = new URL(baseUrl).origin; return `${baseOrigin}${relativeUrl}`; } catch { return relativeUrl; } }
        else { return `${baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)}${relativeUrl}`; }
    }
}

function rewriteUrlToProxy(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return '';
    return `/proxy/${encodeURIComponent(targetUrl)}`;
}

function getRandomUserAgent() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

function validateAuth(event) {
    const params = new URLSearchParams(event.queryStringParameters || {});
    const authHash = params.get('auth');
    const timestamp = params.get('t');
    const serverPassword = process.env.PASSWORD;
    if (!serverPassword) {
        console.error('服務器未設置 PASSWORD 環境變量，代理訪問被拒絕');
        return false;
    }
    const serverPasswordHash = crypto.createHash('sha256').update(serverPassword).digest('hex');
    if (!authHash || authHash !== serverPasswordHash) {
        console.warn('代理請求鑒權失敗：密碼哈希不匹配');
        return false;
    }
    if (timestamp) {
        const now = Date.now();
        const maxAge = 10 * 60 * 1000;
        if (now - parseInt(timestamp) > maxAge) {
            console.warn('代理請求鑒權失敗：時間戳過期');
            return false;
        }
    }
    return true;
}

async function fetchContentWithType(targetUrl, requestHeaders) {
    const headers = {
        'User-Agent': getRandomUserAgent(),
        'Accept': requestHeaders['accept'] || '*/*',
        'Accept-Language': requestHeaders['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': requestHeaders['referer'] || new URL(targetUrl).origin,
    };
    Object.keys(headers).forEach(key => headers[key] === undefined || headers[key] === null || headers[key] === '' ? delete headers[key] : {});
    logDebug(`Fetching target: ${targetUrl} with headers: ${JSON.stringify(headers)}`);
    try {
        const response = await fetch(targetUrl, { headers, redirect: 'follow' });
        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            logDebug(`Fetch failed: ${response.status} ${response.statusText} - ${targetUrl}`);
            const err = new Error(`HTTP error ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 200)}`);
            err.status = response.status; throw err;
        }
        const arrayBuffer = await response.arrayBuffer();
        const content = Buffer.from(arrayBuffer);
        const contentType = response.headers.get('content-type') || '';
        logDebug(`Fetch success: ${targetUrl}, Content-Type: ${contentType}, Length: ${content.length}`);
        return { content, contentType, responseHeaders: response.headers };
    } catch (error) {
        logDebug(`Fetch exception for ${targetUrl}: ${error.message}`);
        throw new Error(`Failed to fetch target URL ${targetUrl}: ${error.message}`);
    }
}

function isM3u8Content(content, contentType) {
    if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) { return true; }
    return content && typeof content === 'object' && content.toString().trim().startsWith('#EXTM3U');
}

function processKeyLine(line, baseUrl) { return line.replace(/URI="([^"]+)"/, (match, uri) => { const absoluteUri = resolveUrl(baseUrl, uri); logDebug(`Processing KEY URI: Original='${uri}', Absolute='${absoluteUri}'`); return `URI="${rewriteUrlToProxy(absoluteUri)}"`; }); }
function processMapLine(line, baseUrl) { return line.replace(/URI="([^"]+)"/, (match, uri) => { const absoluteUri = resolveUrl(baseUrl, uri); logDebug(`Processing MAP URI: Original='${uri}', Absolute='${absoluteUri}'`); return `URI="${rewriteUrlToProxy(absoluteUri)}"`; }); }
function processMediaPlaylist(url, content) {
    const baseUrl = getBaseUrl(url); if (!baseUrl) { logDebug(`Could not determine base URL for media playlist: ${url}. Cannot process relative paths.`); }
    const lines = content.toString().split('\n'); const output = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim(); if (line && i === lines.length - 1 && !line) { output.push(line); continue; } if (!line) continue;
        if (line.startsWith('#EXT-X-KEY')) { output.push(processKeyLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXT-X-MAP')) { output.push(processMapLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXTINF')) { output.push(line); continue; }
        if (!line.startsWith('#')) { const absoluteUrl = resolveUrl(baseUrl, line); logDebug(`Rewriting media segment: Original='${line}', Resolved='${absoluteUrl}'`); output.push(rewriteUrlToProxy(absoluteUrl)); continue; }
        output.push(line);
    } return output.join('\n');
}
async function processM3u8Content(targetUrl, content, recursionDepth = 0) {
    if (content.toString().includes('#EXT-X-STREAM-INF') || content.toString().includes('#EXT-X-MEDIA:')) { logDebug(`Detected master playlist: ${targetUrl} (Depth: ${recursionDepth})`); return await processMasterPlaylist(targetUrl, content, recursionDepth); }
    logDebug(`Detected media playlist: ${targetUrl} (Depth: ${recursionDepth})`); return processMediaPlaylist(targetUrl, content);
}
async function processMasterPlaylist(url, content, recursionDepth) {
    if (recursionDepth > MAX_RECURSION) { throw new Error(`Max recursion depth (${MAX_RECURSION}) exceeded for master playlist: ${url}`); }
    const baseUrl = getBaseUrl(url); const lines = content.toString().split('\n'); let highestBandwidth = -1; let bestVariantUrl = '';
    for (let i = 0; i < lines.length; i++) { if (lines[i].startsWith('#EXT-X-STREAM-INF')) { const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/); const currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0; let variantUriLine = ''; for (let j = i + 1; j < lines.length; j++) { const line = lines[j].trim(); if (line && !line.startsWith('#')) { variantUriLine = line; i = j; break; } } if (variantUriLine && currentBandwidth >= highestBandwidth) { highestBandwidth = currentBandwidth; bestVariantUrl = resolveUrl(baseUrl, variantUriLine); } } }
    if (!bestVariantUrl) { logDebug(`No BANDWIDTH found, trying first URI in: ${url}`); for (let i = 0; i < lines.length; i++) { const line = lines[i].trim(); if (line && !line.startsWith('#') && line.match(/\.m3u8($|\?.*)/i)) { bestVariantUrl = resolveUrl(baseUrl, line); logDebug(`Fallback: Found first sub-playlist URI: ${bestVariantUrl}`); break; } } }
    if (!bestVariantUrl) { logDebug(`No valid sub-playlist URI found in master: ${url}. Processing as media playlist.`); return processMediaPlaylist(url, content); }
    logDebug(`Selected sub-playlist (Bandwidth: ${highestBandwidth}): ${bestVariantUrl}`);
    const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl, {});
    if (!isM3u8Content(variantContent, variantContentType)) { logDebug(`Fetched sub-playlist ${bestVariantUrl} is not M3U8 (Type: ${variantContentType}). Treating as media playlist.`); return processMediaPlaylist(bestVariantUrl, variantContent); }
    return await processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1);
}

function isBinaryContentType(contentType) {
    if (!contentType) return false;
    const ct = contentType.toLowerCase();
    return (
        ct.startsWith('image/') ||
        ct.startsWith('video/') ||
        ct.startsWith('audio/') ||
        ct.includes('octet-stream') ||
        ct.includes('font-') ||
        ct.includes('application/pdf')
    );
}

export const handler = async (event, context) => {
    console.log('--- Netlify Proxy Request ---');
    console.log('Time:', new Date().toISOString());
    console.log('Method:', event.httpMethod);
    console.log('Path:', event.path);

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
    };

    if (event.httpMethod === 'OPTIONS') {
        logDebug("Handling OPTIONS request");
        return {
            statusCode: 204,
            headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' },
            body: '',
        };
    }

    if (!validateAuth(event)) {
        console.warn('Netlify 代理請求鑒權失敗');
        return {
            statusCode: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, error: '代理訪問未授權：請檢查密碼配置或鑒權參數' }),
        };
    }

    let encodedUrlPath = '';
    const proxyPrefix = '/proxy/';
    if (event.path && event.path.startsWith(proxyPrefix)) {
        encodedUrlPath = event.path.substring(proxyPrefix.length);
        logDebug(`Extracted encoded path from event.path: ${encodedUrlPath}`);
    } else {
        logDebug(`Could not extract encoded path from event.path: ${event.path}`);
    }

    const targetUrl = getTargetUrlFromPath(encodedUrlPath);
    logDebug(`Resolved target URL: ${targetUrl || 'null'}`);

    if (!targetUrl) {
        logDebug('Error: Invalid proxy request path.');
        return {
            statusCode: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, error: "Invalid proxy request path. Could not extract target URL." }),
        };
    }

    logDebug(`Processing proxy request for target: ${targetUrl}`);

    try {
        const isValidAuth = validateAuth(event);
        if (!isValidAuth) {
            return {
                statusCode: 403,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: false, error: "Forbidden: Invalid auth credentials." }),
            };
        }

        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl, event.headers);

        // --- Process if M3U8 ---
        if (isM3u8Content(content, contentType)) {
            logDebug(`Processing M3U8 content: ${targetUrl}`);
            const processedM3u8 = await processM3u8Content(targetUrl, content);
            logDebug(`Successfully processed M3U8 for ${targetUrl}`);
            return {
                statusCode: 200,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/vnd.apple.mpegurl;charset=utf-8',
                    'Cache-Control': `public, max-age=${CACHE_TTL}`,
                },
                body: processedM3u8,
            };
        }

        // --- Binary-safe return for image/video/audio/etc. ---
        if (isBinaryContentType(contentType)) {
            const base64Content = content.toString('base64');
            logDebug(`Returning binary content as base64: ${targetUrl}, Type: ${contentType}, Length: ${content.length}`);
            const netlifyHeaders = { ...corsHeaders, 'Content-Type': contentType };
            responseHeaders.forEach((value, key) => {
                const lowerKey = key.toLowerCase();
                if (!lowerKey.startsWith('access-control-') && lowerKey !== 'content-encoding' && lowerKey !== 'content-length') {
                    netlifyHeaders[key] = value;
                }
            });
            netlifyHeaders['Cache-Control'] = `public, max-age=${CACHE_TTL}`;
            return {
                statusCode: 200,
                headers: netlifyHeaders,
                body: base64Content,
                isBase64Encoded: true,
            };
        }

        // --- Return Original Content (Non-M3U8 text) ---
        logDebug(`Returning non-M3U8 text content directly: ${targetUrl}, Type: ${contentType}`);
        const netlifyHeaders = { ...corsHeaders };
        responseHeaders.forEach((value, key) => {
            const lowerKey = key.toLowerCase();
            if (!lowerKey.startsWith('access-control-') && lowerKey !== 'content-encoding' && lowerKey !== 'content-length') {
                netlifyHeaders[key] = value;
            }
        });
        netlifyHeaders['Cache-Control'] = `public, max-age=${CACHE_TTL}`;

        return {
            statusCode: 200,
            headers: netlifyHeaders,
            body: content.toString(),
        };

    } catch (error) {
        logDebug(`ERROR in proxy processing for ${targetUrl}: ${error.message}`);
        console.error(`[Proxy Error Stack Netlify] ${error.stack}`);
        const statusCode = error.status || 500;
        return {
            statusCode: statusCode,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, error: `Proxy processing error: ${error.message}`, targetUrl }),
        };
    }
};
