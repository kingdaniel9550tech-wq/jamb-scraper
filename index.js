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

        // 1. Navigate to JAMB portal login
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

        // 3. Wait for dashboard and click "Check Admission Status" or "CAPS" tile
        await new Promise(r => setTimeout(r, 4000));

        try {
            await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('a, button, div, span, h4'));
                const target = elements.find(el => {
                    const t = el.innerText.toLowerCase();
                    return t.includes('admission status') || t.includes('caps') || t.includes('check admission');
                });
                if (target) target.click();
            });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 5000)); // Wait for CAPS page to load
        } catch (e) {
            console.log("Could not auto-click CAPS tile, parsing dashboard text...");
        }

        // 4. Clean Data Extractor with Blacklist Filtering
        const candidateData = await page.evaluate(() => {
            const bodyText = document.body.innerText || "";
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            let profileCode = "Not Found";
            let name = "Verified Candidate";
            let institution = "Not Yet Loaded in CAPS";
            let course = "Not Yet Loaded in CAPS";

            // Blacklist keywords to ignore service buttons and footers
            const ignoreList = [
                "application for", "correction", "condonement", "enquiries", 
                "support", "complaint", "jamb", "dashboard", "portal", "sign out", 
                "profile", "password", "register", "payment", "history"
            ];

            const isValidText = (text) => {
                if (!text || text.length < 3) return false;
                const lower = text.toLowerCase();
                return !ignoreList.some(ig => lower.includes(ig));
            };

            // Extract Profile Code (10 characters starting with a digit)
            const pcMatch = bodyText.match(/\b([0-9][A-Z0-9]{9})\b/);
            if (pcMatch) profileCode = pcMatch[1];

            // Scan lines for valid candidate info
            for (let i = 0; i < lines.length; i++) {
                const cur = lines[i].toLowerCase();

                // Name extraction
                if ((cur.includes("welcome") || cur.includes("candidate:")) && lines[i+1] && isValidText(lines[i+1])) {
                    name = lines[i+1].replace(/[:]/g, '').trim();
                }

                // Institution extraction (looking for university/polytechnic/college names)
                if ((cur.includes("institution") || cur.includes("university") || cur.includes("polytechnic") || cur.includes("college")) && lines[i+1]) {
                    if (isValidText(lines[i+1])) institution = lines[i+1];
                }

                // Course / Programme extraction
                if ((cur.includes("programme") || cur.includes("course") || cur.includes("department")) && lines[i+1]) {
                    if (isValidText(lines[i+1])) course = lines[i+1];
                }
            }

            // Fallback for name if welcome tag wasn't caught
            if (name === "Verified Candidate") {
                const possibleName = lines.find(l => /^[A-Z]+\s+[A-Z]+(\s+[A-Z]+)?$/.test(l) && isValidText(l));
                if (possibleName) name = possibleName;
            }

            return {
                name: name,
                profileCode: profileCode,
                institution: institution,
                course: course,
                status: bodyText.includes("Admitted") ? "🎉 ADMISSION OFFERED / APPROVED" : "⏳ Admission in Progress / Not Admitted Yet"
            };
        });

        await browser.close();
        return res.json({ success: true, data: candidateData, message: "Successfully fetched clean details." });

    } catch (error) {
        if (browser) await browser.close();
        console.error("Cloud Scraper Error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper API running on port ${PORT}`));
