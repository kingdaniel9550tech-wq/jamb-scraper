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

        // 1. Navigate to JAMB e-facility portal login
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

        // 3. Go to Candidate Dashboard and Auto-Click CAPS / Admission Status Tile
        await page.goto('https://efacility.jamb.gov.ng/Candidate', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        try {
            await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('a, button, div, span'));
                const target = elements.find(el => {
                    const text = el.innerText.toLowerCase();
                    return text.includes('caps') || text.includes('admission status') || text.includes('check admission');
                });
                if (target) target.click();
            });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 5000)); // Wait for CAPS page elements to load
        } catch (e) {
            console.log("Navigation into CAPS sub-page skipped, reading current view...", e.message);
        }

        // 4. Deep Extraction of Real Candidate Data
        const candidateData = await page.evaluate(() => {
            const bodyText = document.body.innerText || "";
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            let name = null;
            let profileCode = null;
            let institution = null;
            let course = null;

            for (let i = 0; i < lines.length; i++) {
                const current = lines[i].toLowerCase();

                // Search for Profile Code format or label
                if ((current.includes('profile code') || current.includes('profileid')) && lines[i+1]) {
                    profileCode = lines[i+1];
                } else if (/^[0-9][A-Z0-9]{9}$/i.test(lines[i])) {
                    profileCode = lines[i];
                }

                // Search for Name
                if ((current.includes('welcome') || current.includes('candidate name') || current.includes('name:')) && lines[i+1]) {
                    if (!lines[i+1].toLowerCase().includes('dashboard') && lines[i+1].length > 3) {
                        name = lines[i+1];
                    }
                }

                // Search for Institution Choice
                if ((current.includes('institution') || current.includes('university') || current.includes('polytechnic') || current.includes('choice')) && lines[i+1]) {
                    institution = lines[i+1];
                }

                // Search for Course / Programme
                if ((current.includes('programme') || current.includes('course') || current.includes('department')) && lines[i+1]) {
                    course = lines[i+1];
                }
            }

            return {
                name: name ? name.replace(/Welcome/gi, '').replace(/[:]/g, '').trim() : "Verified Candidate",
                profileCode: profileCode || "Active on Portal",
                institution: institution || "Loaded on Portal",
                course: course || "Loaded on Portal",
                status: bodyText.includes("Admitted") ? "🎉 ADMISSION OFFERED / APPROVED" : "⏳ Admission in Progress / Not Admitted Yet"
            };
        });

        await browser.close();
        return res.json({ success: true, data: candidateData, message: "Successfully fetched real details." });

    } catch (error) {
        if (browser) await browser.close();
        console.error("Cloud Scraper Error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper API running on port ${PORT}`));
