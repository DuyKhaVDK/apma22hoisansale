// netlify/functions/api.js
require('dotenv').config();
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const router = express.Router();


const DB_ROOT = process.env.DB_ROOT;

const APP_ID = process.env.APP_ID;     
const APP_SECRET = process.env.APP_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET; 
const AFF_ID = process.env.AFF_ID || "17340750539";
const AFFIPAD_API_KEY = process.env.AFFIPAD_API_KEY;
const AFFIPAD_BASE_URL = 'https://api.affipad.com';
const REQUIRED_SUB_ID = 'fbreels03';
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

let AFFIPAD_TOOL_ID = process.env.AFFIPAD_TOOL_ID || null;


async function resolveAndProcessUrl(inputUrl) {
    let finalUrl = inputUrl;
    if (/(s\.shopee\.vn|shp\.ee|s\.shope\.ee|vn\.shp\.ee|shope\.ee)/.test(inputUrl)) {
        try {
            const response = await axios.get(inputUrl, { 
                maxRedirects: 10, timeout: 8000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
                validateStatus: null
            });
            finalUrl = response.request?.res?.responseUrl || response.headers['location'] || inputUrl;
        } catch (e) { console.log(`>> Lỗi giải mã: ${inputUrl}`); }
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

// --- HÀM 2: LẤY THÔNG TIN SẢN PHẨM ---
async function getShopeeProductInfo(itemId) {
    if (!itemId) return null;
    const timestamp = Math.floor(Date.now() / 1000);
    const query = `query { productOfferV2(itemId: ${itemId}) { nodes { productName imageUrl } } }`;
    const payloadString = JSON.stringify({ query });
    const signature = crypto.createHash('sha256').update(`${APP_ID}${timestamp}${payloadString}${APP_SECRET}`).digest('hex');
    try {
        const response = await axios.post(SHOPEE_API_URL, payloadString, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}` }
        });
        return response.data.data?.productOfferV2?.nodes?.[0] || null;
    } catch (e) { return null; }
}

// --- HÀM 3: LẤY DANH SÁCH TOOLS TỪ AFFIPAD ---
async function getAffipadTools() {
    if (!AFFIPAD_API_KEY) {
        console.log('⚠️ AFFIPAD_API_KEY chưa được cấu hình');
        return null;
    }
    try {
        const response = await axios.get(`${AFFIPAD_BASE_URL}/v1/tools`, {
            headers: {
                'Authorization': `Bearer ${AFFIPAD_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 8000
        });
        if (response.data.success && response.data.data.tools.length > 0) {
            const firstTool = response.data.data.tools[0];
            console.log(`✅ AffiPad Tool: ${firstTool.name} (${firstTool.id})`);
            return firstTool.id;
        }
    } catch (e) {
        console.error('❌ Lỗi lấy AffiPad tools:', e.message);
    }
    return null;
}

// --- HÀM 4: CHUYỂN ĐỔI LINK VIA AFFIPAD ---
async function convertViaAffipad(originalUrl, subIds = []) {
    if (!AFFIPAD_API_KEY || !AFFIPAD_TOOL_ID) {
        console.log('⚠️ AffiPad không cấu hình đủ, dùng fallback...');
        return generateUniversalLink(originalUrl, subIds);
    }
    try {
        const response = await axios.post(
            `${AFFIPAD_BASE_URL}/v1/fb-convert`,
            {
                url: originalUrl,
                toolId: AFFIPAD_TOOL_ID,
                useShortLink: true,
                subIds: subIds.length > 0 ? subIds : [REQUIRED_SUB_ID]
            },
            {
                headers: {
                    'Authorization': `Bearer ${AFFIPAD_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );
        if (response.data.success && response.data.data.results.length > 0) {
            const result = response.data.data.results[0];
            console.log(`✅ AffiPad convert OK: ${result.shortUrl || result.link}`);
            return result.shortUrl || result.link;
        }
    } catch (e) {
        console.error('❌ AffiPad convert error:', e.response?.data?.message || e.message);
    }
    return generateUniversalLink(originalUrl, subIds);
}

// --- HÀM 5: TẠO LINK CHUẨN (UNIVERSAL REDIR) ---
function generateUniversalLink(originalUrl, subIds = []) {
    const encodedUrl = encodeURIComponent(originalUrl);
    let finalSubId = subIds.length > 0 ? subIds.join('-') : REQUIRED_SUB_ID;
    return `https://s.shopee.vn/an_redir?origin_link=${encodedUrl}&affiliate_id=${AFF_ID}&sub_id=${finalSubId}`;
}

// --- ROUTER CHÍNH: CHUYỂN ĐỔI & ĐẾM LƯỢT ---
router.post('/convert-text', async (req, res) => {
    const { text, subIds } = req.body;
    const urlRegex = /((?:https?:\/\/)?(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn|s\.shope\.ee)[^\s]*)/gi;
    const foundLinks = text.match(urlRegex) || [];
    const uniqueLinks = [...new Set(foundLinks)];

    if (uniqueLinks.length === 0) return res.json({ success: false, converted: 0 });

    // Lần đầu: lấy tool ID từ AffiPad nếu chưa có
    if (!AFFIPAD_TOOL_ID && AFFIPAD_API_KEY) {
        AFFIPAD_TOOL_ID = await getAffipadTools();
    }

    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        const { cleanedUrl, itemId } = await resolveAndProcessUrl(url.startsWith('http') ? url : `https://${url}`);
        const [short, info] = await Promise.all([
            convertViaAffipad(cleanedUrl, subIds || [REQUIRED_SUB_ID]),
            getShopeeProductInfo(itemId)
        ]);
        return { original: url, short, productName: info?.productName || "Sản phẩm Shopee", imageUrl: info?.imageUrl || "" };
    }));

   
    try {
        const count = conversions.length;
        const now = new Date();
        const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); 
        const dbRes = await axios.get(`${DB_ROOT}.json`);
        const dbData = dbRes.data || {};
        const stats = dbData.stats || {};
        const dailyVal = dbData.daily?.[today] || 0;

        let newTotal = (stats.last_date !== today) ? count : (stats.total_converted || 0) + count;

        await axios.patch(`${DB_ROOT}.json`, {
            stats: {
                total_converted: newTotal,
                last_date: today,
                last_updated: now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
            },
            [`daily/${today}`]: dailyVal + count
        });
    } catch (e) { console.error("Firebase Update Error"); }

    res.json({ success: true, converted: conversions.length, details: conversions });
});

// --- ROUTER ADMIN ---
router.get('/admin/stats', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (token !== ADMIN_SECRET) return res.status(403).json({ success: false });
    try {
        const response = await axios.get(`${DB_ROOT}.json`);
        const dbData = response.data || {};
        res.json({
            success: true,
            total_converted_links: dbData.stats?.total_converted || 0,
            last_updated: dbData.stats?.last_updated || "Chưa có dữ liệu",
            daily: dbData.daily || {} 
        });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api', router);
module.exports.handler = serverless(app);
