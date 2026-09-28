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

        // 3. Navigate to Candidate Dashboard / CAPS
        await page.goto('https://efacility.jamb.gov.ng/Candidate', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000)); // Allow full dashboard rendering

        // 4. Advanced DOM & Text Parsing to pull exact candidate data
        const candidateData = await page.evaluate(() => {
            const getByLabel = (keywords) => {
                const elements = Array.from(document.querySelectorAll('span, p, div, td, th, label, h4, h3, b, strong'));
                for (let el of elements) {
                    const text = el.innerText.trim();
                    for (let kw of keywords) {
                        if (text.toLowerCase().includes(kw.toLowerCase())) {
                            if (text.includes(':')) {
                                const parts = text.split(':');
                                if (parts[1] && parts[1].trim().length > 1) return parts[1].trim();
                            }
                            if (el.nextElementSibling) {
                                const siblingText = el.nextElementSibling.innerText.trim();
                                if (siblingText && siblingText.length > 1) return siblingText;
                            }
                        }
                    }
                }
                return null;
            };

            const fullText = document.body.innerText;
            const matchRegex = (regex) => {
                const match = fullText.match(regex);
                return match && match[1] ? match[1].trim() : null;
            };

            let name = getByLabel(['welcome', 'candidate name', 'full name', 'name']) || 
                       matchRegex(/Welcome,?\s*([A-Z\s]+)(?:\n|$)/i);

            let profileCode = getByLabel(['profile code', 'profileid', 'code']) || 
                              matchRegex(/Profile\s*Code[:\s]*([A-Z0-9]+)/i);

            let institution = getByLabel(['institution', 'university', 'polytechnic', 'choice']) || 
                              matchRegex(/Institution[:\s]*([A-Za-z\s()]+)(?:\n|$)/i);

            let course = getByLabel(['course', 'programme', 'department']) || 
                         matchRegex(/(?:Course|Programme|Department)[:\s]*([A-Za-z\s()\/]+)(?:\n|$)/i);

            if (name) {
                name = name.split('\n')[0].replace(/Welcome/gi, '').replace(/[:]/g, '').trim();
            }

            return {
                name: name || matchRegex(/([A-Z]{3,}\s+[A-Z]{3,}\s+[A-Z]{3,})/i) || "Verified Student",
                profileCode: profileCode || "Available on Portal",
                institution: institution || "Selected Institution",
                course: course || "Applied Program",
                status: fullText.includes("Admitted") ? "🎉 ADMISSION OFFERED / APPROVED" : "⏳ Admission in Progress / Not Admitted Yet"
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
