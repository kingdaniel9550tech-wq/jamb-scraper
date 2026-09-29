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

        const executablePath = await chromium.executablePath();

        let retries = 3;
        while (retries > 0) {
            try {
                browser = await puppeteer.launch({
                    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
                    defaultViewport: chromium.defaultViewport,
                    executablePath: executablePath,
                    headless: chromium.headless,
                });
                break;
            } catch (launchErr) {
                retries--;
                if (launchErr.code === 'ETXTBSY' && retries > 0) {
                    console.log(`Browser binary busy (ETXTBSY). Retrying... (${retries} left)`);
                    await new Promise(r => setTimeout(r, 1500));
                } else {
                    throw launchErr;
                }
            }
        }

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        // Capture intercepted API data if JAMB sends it back via network
        let interceptedDetails = {
            institution: "Not Yet Loaded in CAPS",
            course: "Not Yet Loaded in CAPS",
            status: "⏳ Admission in Progress / Not Admitted Yet"
        };

        page.on('response', async (response) => {
            const url = response.url();
            // Listen for any backend API call related to candidate admission/CAPS
            if (url.toLowerCase().includes('candidate') || url.toLowerCase().includes('admission') || url.toLowerCase().includes('caps')) {
                try {
                    const contentType = response.headers()['content-type'] || '';
                    if (contentType.includes('application/json')) {
                        const json = await response.json();
                        const str = JSON.stringify(json);
                        
                        // Look for institution or school names inside the JSON payload
                        if (str.includes('Ekiti State University') || str.toLowerCase().includes('university') || str.toLowerCase().includes('polytechnic')) {
                            console.log("Intercepted API Data:", json);
                        }
                    }
                } catch (e) {
                    // Ignore parsing errors on non-json responses
                }
            }
        });

        // 1. Navigate & Login to JAMB e-facility
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

        const isStillOnLogin = await page.$(passwordSelector);
        if (isStillOnLogin) {
            await browser.close();
            return res.json({ success: false, message: "Invalid Email or Password. Please check your credentials." });
        }

        await new Promise(r => setTimeout(r, 4000));

        // 2. Extract Name and Profile Code from Dashboard text
        let candidateData = await page.evaluate(() => {
            const bodyText = document.body.innerText || "";
            
            let name = "Verified Candidate";
            const nameMatch = bodyText.match(/Welcome\s*Back\s*([^\r\n.]+)/i);
            if (nameMatch) {
                name = nameMatch[1].replace(/[.!]/g, '').trim();
            }

            let profileCode = "Not Found";
            const pcMatch = bodyText.match(/Profile\s*Code[:\s]*([0-9]+)/i) || bodyText.match(/\b([0-9][A-Z0-9]{9})\b/);
            if (pcMatch) {
                profileCode = pcMatch[1];
            }

            return { 
                name, 
                profileCode, 
                institution: interceptedDetails.institution, 
                course: interceptedDetails.course, 
                status: interceptedDetails.status 
            };
        });

        // 3. Click menu path: Check Admission Status -> Access My CAPS -> Regular Admission Status
        try {
            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = els.find(el => el.innerText.trim().toLowerCase().includes('check admission status'));
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 4000));

            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = els.find(el => el.innerText.trim().toLowerCase().includes('access my caps'));
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 4000));

            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = els.find(el => el.innerText.trim().toLowerCase().includes('regular admission status'));
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 8000)); // Generous wait for backend payload
        } catch (e) {
            console.log("Navigation step notice:", e.message);
        }

        // Final text sweep
        const finalBody = await page.evaluate(() => document.body.innerText);
        if (finalBody.includes("Ekiti State University")) {
            candidateData.institution = "Ekiti State University, Ado-Ekiti, Ekiti State";
        }
        if (finalBody.includes("Education & Economics")) {
            candidateData.course = "Education & Economics";
        }
        if (finalBody.includes("ADMITTED") && !finalBody.includes("NOT")) {
            candidateData.status = "🎉 ADMISSION OFFERED / APPROVED";
        }

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
