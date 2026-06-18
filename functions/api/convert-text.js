const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';
const AFFIPAD_BASE_URL = 'https://api.affipad.com';
const REQUIRED_SUB_ID = 'reelsPhuong';

let cachedToolId = null;

async function sha256Hex(str) {
    const data = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function resolveAndProcessUrl(inputUrl) {
    let finalUrl = inputUrl;
    if (/(s\.shopee\.vn|shp\.ee|s\.shope\.ee|vn\.shp\.ee|shope\.ee)/.test(inputUrl)) {
        try {
            const response = await fetch(inputUrl, {
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
            });
            finalUrl = response.url || inputUrl;
        } catch (e) {}
    }
    const dashIMatch = finalUrl.match(/-i\.(\d+)\.(\d+)/);
    const productPathMatch = finalUrl.match(/\/product\/\d+\/(\d+)/);
    const genericIdMatch = finalUrl.match(/(?:itemId=|\/product\/)(\d+)/);
    let itemId = dashIMatch ? dashIMatch[2] : (productPathMatch ? productPathMatch[1] : (genericIdMatch ? genericIdMatch[1] : null));
    if (!itemId) {
        const lastDigitMatch = finalUrl.match(/\/(\d+)(?:\?|$)/);
        itemId = lastDigitMatch ? lastDigitMatch[1] : null;
    }
    let cleanedUrl = finalUrl.split('?')[0];
    const match = cleanedUrl.match(/shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/);
    if (match) cleanedUrl = `https://shopee.vn/product/${match[2]}/${match[3]}`;
    return { cleanedUrl, itemId };
}

async function getShopeeProductInfo(itemId, APP_ID, APP_SECRET) {
    if (!itemId) return null;
    const timestamp = Math.floor(Date.now() / 1000);
    const query = `query { productOfferV2(itemId: ${itemId}) { nodes { productName imageUrl } } }`;
    const payloadString = JSON.stringify({ query });
    const signature = await sha256Hex(`${APP_ID}${timestamp}${payloadString}${APP_SECRET}`);
    try {
        const response = await fetch(SHOPEE_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}`
            },
            body: payloadString
        });
        const data = await response.json();
        return data.data?.productOfferV2?.nodes?.[0] || null;
    } catch (e) { return null; }
}

async function getAffipadTools(AFFIPAD_API_KEY) {
    if (!AFFIPAD_API_KEY) return null;
    try {
        const response = await fetch(`${AFFIPAD_BASE_URL}/v1/tools`, {
            headers: { 'Authorization': `Bearer ${AFFIPAD_API_KEY}`, 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        if (data.success && data.data.tools.length > 0) {
            return data.data.tools[0].id;
        }
    } catch (e) {}
    return null;
}

function generateUniversalLink(originalUrl, subIds = [], affId) {
    const encodedUrl = encodeURIComponent(originalUrl);
    const finalSubId = subIds.length > 0 ? subIds.join('-') : REQUIRED_SUB_ID;
    return `https://s.shopee.vn/an_redir?origin_link=${encodedUrl}&affiliate_id=${affId}&sub_id=${finalSubId}`;
}

async function convertViaAffipad(originalUrl, subIds, AFFIPAD_API_KEY, toolId, AFF_ID) {
    if (!AFFIPAD_API_KEY || !toolId) {
        return generateUniversalLink(originalUrl, subIds, AFF_ID);
    }
    try {
        const response = await fetch(`${AFFIPAD_BASE_URL}/v1/fb-convert`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${AFFIPAD_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: originalUrl, toolId, useShortLink: true, subIds: subIds.length > 0 ? subIds : [REQUIRED_SUB_ID] })
        });
        const data = await response.json();
        if (data.success && data.data.results.length > 0) {
            const result = data.data.results[0];
            return result.shortUrl || result.link;
        }
    } catch (e) {}
    return generateUniversalLink(originalUrl, subIds, AFF_ID);
}

export async function onRequestPost(context) {
    const { request, env } = context;
    const { text, subIds } = await request.json();

    const APP_ID = env.APP_ID;
    const APP_SECRET = env.APP_SECRET;
    const AFF_ID = env.AFF_ID || "17318740425";
    const AFFIPAD_API_KEY = env.AFFIPAD_API_KEY;

    const urlRegex = /((?:https?:\/\/)?(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn|s\.shope\.ee)[^\s]*)/gi;
    const foundLinks = text.match(urlRegex) || [];
    const uniqueLinks = [...new Set(foundLinks)];

    if (uniqueLinks.length === 0) {
        return new Response(JSON.stringify({ success: false, converted: 0 }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    let toolId = env.AFFIPAD_TOOL_ID || cachedToolId;
    if (!toolId && AFFIPAD_API_KEY) {
        toolId = await getAffipadTools(AFFIPAD_API_KEY);
        if (toolId) cachedToolId = toolId;
    }

    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        const { cleanedUrl, itemId } = await resolveAndProcessUrl(url.startsWith('http') ? url : `https://${url}`);
        const [short, info] = await Promise.all([
            convertViaAffipad(cleanedUrl, subIds || [REQUIRED_SUB_ID], AFFIPAD_API_KEY, toolId, AFF_ID),
            getShopeeProductInfo(itemId, APP_ID, APP_SECRET)
        ]);
        return {
            original: url,
            short,
            shortInstagram: generateUniversalLink(cleanedUrl, ["instagram"], "17318740425"),
            productName: info?.productName || "Sản phẩm Shopee",
            imageUrl: info?.imageUrl || ""
        };
    }));

    return new Response(JSON.stringify({ success: true, converted: conversions.length, details: conversions }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function onRequestOptions() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        }
    });
}
