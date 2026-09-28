const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

// 1. ADD THIS: A simple GET route so you can open your URL in a mobile browser to test if it's online!
app.get('/', (req, res) => {
    res.send('👑 JAMB Scraper API is active and online!');
});

app.post('/check-jamb', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Missing email or password." });
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled'
            ]
        });

        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        await page.goto('https://efacility.jamb.gov.ng/', { waitUntil: 'networkidle2', timeout: 45000 });

        const emailSelector = 'input#Email, input#email, input[name="Email"], input[name="email"]';
        const passwordSelector = 'input#Password, input#password, input[name="Password"], input[name="password"]';

        await page.waitForSelector(emailSelector, { timeout: 15000 });
        await page.type(emailSelector, email, { delay: 30 });

        await page.waitForSelector(passwordSelector, { timeout: 15000 });
        await page.type(passwordSelector, password, { delay: 30 });

        const loginBtnSelector = 'button[type="submit"], input[type="submit"], #loginButton, button.btn-primary';
        await page.waitForSelector(loginBtnSelector, { timeout: 10000 });

        await Promise.all([
            page.click(loginBtnSelector),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
        ]);

        const currentUrl = page.url();
        if (currentUrl.includes('login') || currentUrl.includes('error') || currentUrl.includes('account/login')) {
            await browser.close();
            return res.json({ success: false, message: "Authentication Failed. Please check your credentials." });
        }

        await page.goto('https://efacility.jamb.gov.ng/Candidate', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        const bodyText = await page.evaluate(() => document.body.innerText);
        const status = bodyText.includes("Admitted") ? "Admission Offered / Approved" : "Admission in Progress / Not Admitted yet";

        await browser.close();
        return res.json({ success: true, status, message: "Successfully fetched status." });

    } catch (error) {
        if (browser) await browser.close();
        console.error("Scraper Error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper API running on port ${PORT}`));
