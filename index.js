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

        // 1. Navigate to JAMB portal
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

        // 2. Strict Authentication Validation
        const isStillOnLogin = await page.$(passwordSelector);
        if (isStillOnLogin) {
            await browser.close();
            return res.json({ success: false, message: "Invalid Email or Password. Please check your credentials." });
        }

        // 3. Navigate to Candidate Dashboard
        await page.goto('https://efacility.jamb.gov.ng/Candidate', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000)); // Allow full DOM render

        // 4. Clean, Line-by-Line Content Parser
        const candidateData = await page.evaluate(() => {
            const bodyText = document.body.innerText || "";
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            let name = "Verified Candidate";
            let profileCode = "Available on Portal";
            let institution = "Selected Institution";
            let course = "Applied Program";

            for (let i = 0; i < lines.length; i++) {
                const current = lines[i].toLowerCase();
                
                // Look for Name indicators
                if ((current.includes("welcome") || current.includes("name")) && lines[i+1]) {
                    if (!lines[i+1].toLowerCase().includes("dashboard") && lines[i+1].length > 3) {
                        name = lines[i+1];
                    }
                }
                // Look for Profile Code indicators
                if (current.includes("profile code") && lines[i+1]) {
                    profileCode = lines[i+1];
                }
                // Look for Institution choices
                if ((current.includes("institution") || current.includes("university") || current.includes("polytechnic")) && lines[i+1]) {
                    institution = lines[i+1];
                }
                // Look for Course/Program choices
                if ((current.includes("programme") || current.includes("course") || current.includes("department")) && lines[i+1]) {
                    course = lines[i+1];
                }
            }

            return {
                name: name !== "Verified Candidate" ? name : (lines.find(l => l.length > 5 && l === l.toUpperCase()) || "JAMB Student"),
                profileCode: profileCode,
                institution: institution,
                course: course,
                status: bodyText.includes("Admitted") ? "🎉 ADMISSION OFFERED / APPROVED" : "⏳ Admission in Progress / Not Admitted Yet"
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
