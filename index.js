const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());

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
        chromium.setHeadlessMode = true;
        chromium.setGraphicsMode = false;

        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        // 1. Navigate to JAMB portal and login
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

        // 2. Navigate to Candidate Dashboard / CAPS
        await page.goto('https://efacility.jamb.gov.ng/Candidate', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        // 3. Extract candidate details and status from page content
        const candidateData = await page.evaluate(() => {
            const pageText = document.body.innerText;
            
            // Helper function to extract fields using regex search on page text
            const extract = (regex) => {
                const match = pageText.match(regex);
                return match ? match[1].trim() : "Not Available";
            };

            return {
                name: extract(/(?:Welcome|Candidate Name)[:\s]*([A-Z\s]+)(?:\n|$)/i) || "Valued Candidate",
                regNo: extract(/([0-9]{9}[A-Z]{2})/i) || extract(/Reg(?:istration)?\s*(?:No|Number)[:\s]*([A-Z0-9\/]+)/i) || "N/A",
                institution: extract(/Institution[:\s]*([A-Za-z\s()]+)(?:\n|$)/i) || "Check Portal",
                course: extract(/(?:Course|Programme|Department)[:\s]*([A-Za-z\s()\/]+)(?:\n|$)/i) || "Check Portal",
                status: pageText.includes("Admitted") ? "🎉 ADMISSION OFFERED / APPROVED" : "⏳ Admission in Progress / Not Admitted Yet"
            };
        });

        await browser.close();
        return res.json({ success: true, data: candidateData, message: "Successfully fetched details." });

    } catch (error) {
        if (browser) await browser.close();
        console.error("Cloud Scraper Error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper API running on port ${PORT}`));
