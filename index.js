const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());

app.get('/', (reg, res) => {
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

        // 1. Navigate to JAMB e-facility portal
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

        // 2. Validate Login Success
        const isStillOnLogin = await page.$(passwordSelector);
        if (isStillOnLogin) {
            await browser.close();
            return res.json({ success: false, message: "Invalid Email or Password. Please check your credentials." });
        }

        // 3. Navigate to Profile / Candidate Section to pull real profile info
        await page.goto('https://efacility.jamb.gov.ng/Candidate', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        // Scrape text from the profile dashboard
        let extractedData = await page.evaluate(() => {
            const getTableVal = (labelText) => {
                const tds = Array.from(document.querySelectorAll('td, th, span, label, div'));
                for (let i = 0; i < tds.length; i++) {
                    if (tds[i].innerText.toLowerCase().includes(labelText.toLowerCase())) {
                        if (tds[i+1]) return tds[i+1].innerText.trim();
                        if (tds[i].nextElementSibling) return tds[i].nextElementSibling.innerText.trim();
                    }
                }
                return null;
            };

            const bodyText = document.body.innerText || "";
            return {
                rawText: bodyText,
                name: getTableVal('name') || getTableVal('candidate') || null,
                profileCode: getTableVal('profile code') || getTableVal('profile') || null,
            };
        });

        // 4. Try navigating to Check Admission Status page to fetch choice/status
        try {
            await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a, button, div'));
                const admissionLink = links.find(el => el.innerText.toLowerCase().includes('admission status') || el.innerText.toLowerCase().includes('caps'));
                if (admissionLink) admissionLink.click();
            });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 4000));

            const admissionPageText = document.body.innerText || "";
            extractedData.rawText += "\n" + admissionPageText;
        } catch (e) {
            console.log("Could not auto-click admission tab, parsing current text...");
        }

        // Final deep regex / keyword extraction
        const fullBody = extractedData.rawText;
        
        // Find Profile Code via pattern match if table lookup missed it
        const profileCodeMatch = fullBody.match(/(?:Profile\s*Code[:\s]*)([A-Z0-9]{10})/i) || fullBody.match(/\b([0-9][A-Z0-9]{9})\b/);
        const finalProfileCode = extractedData.profileCode && extractedData.profileCode.length > 3 ? extractedData.profileCode : (profileCodeMatch ? profileCodeMatch[1] : "Available on Portal");

        // Find Name pattern
        const nameMatch = fullBody.match(/(?:Welcome,?\s*([A-Z\s]+)(?:\n|$))/i);
        const finalName = extractedData.name && extractedData.name.length > 3 ? extractedData.name : (nameMatch ? nameMatch[1].trim() : "Candidate");

        // Find Institution & Course keywords
        const instMatch = fullBody.match(/(?:Institution[:\s]*([A-Za-z\s()]+))/i);
        const courseMatch = fullBody.match(/(?:Course|Programme|Department[:\s]*([A-Za-z\s()\/]+))/i);

        const candidateData = {
            name: finalName,
            profileCode: finalProfileCode,
            institution: instMatch ? instMatch[1].trim() : "Loaded on Portal",
            course: courseMatch ? courseMatch[1].trim() : "Loaded on Portal",
            status: fullBody.includes("Admitted") ? "🎉 ADMISSION OFFERED / APPROVED" : "⏳ Admission in Progress / Not Admitted Yet"
        };

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
