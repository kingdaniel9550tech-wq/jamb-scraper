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

        // 2. Validate Login Success
        const isStillOnLogin = await page.$(passwordSelector);
        if (isStillOnLogin) {
            await browser.close();
            return res.json({ success: false, message: "Invalid Email or Password. Please check your credentials." });
        }

        // 3. Wait for dashboard to render
        await new Promise(r => setTimeout(r, 4000));

        // Try to click into "Check Admission Status" or CAPS if available to expose course/institution
        try {
            await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a, button, div, span'));
                const target = links.find(el => {
                    const t = el.innerText.toLowerCase();
                    return t.includes('admission status') || t.includes('caps') || t.includes('check admission');
                });
                if (target) target.click();
            });
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 4000));
        } catch (e) {
            console.log("Could not auto-click sub-menu, reading main dashboard...");
        }

        // 4. Advanced Data Extraction
        const candidateData = await page.evaluate(() => {
            const bodyText = document.body.innerText || "";
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            let profileCode = "Not Found";
            let name = "Candidate";
            let institution = "Not Specified";
            let course = "Not Specified";

            // Find Profile Code (10-character alphanumeric string)
            const pcMatch = bodyText.match(/\b([0-9][A-Z0-9]{9})\b/);
            if (pcMatch) profileCode = pcMatch[1];

            // Scan lines for candidate attributes
            for (let i = 0; i < lines.length; i++) {
                const cur = lines[i].toLowerCase();

                // Candidate Name detection
                if ((cur.includes("welcome") || cur.includes("candidate:")) && lines[i+1] && lines[i+1].length > 3) {
                    name = lines[i+1].replace(/[:]/g, '').trim();
                }

                // Institution detection
                if ((cur.includes("institution") || cur.includes("university") || cur.includes("polytechnic")) && lines[i+1] && lines[i+1].length > 3) {
                    institution = lines[i+1];
                }

                // Course / Programme detection
                if ((cur.includes("programme") || cur.includes("course") || cur.includes("department")) && lines[i+1] && lines[i+1].length > 3) {
                    course = lines[i+1];
                }
            }

            // Fallback: search for an all-caps full name line if 'Welcome' scan missed it
            if (name === "Candidate") {
                const upperLine = lines.find(l => /^[A-Z]+\s+[A-Z]+(\s+[A-Z]+)?$/.test(l) && !l.includes("JAMB") && !l.includes("DASHBOARD") && !l.includes("PORTAL") && !l.includes("WELCOME"));
                if (upperLine) name = upperLine;
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
        return res.json({ success: true, data: candidateData, message: "Successfully fetched all details." });

    } catch (error) {
        if (browser) await browser.close();
        console.error("Cloud Scraper Error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper API running on port ${PORT}`));
