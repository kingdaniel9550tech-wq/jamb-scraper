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

        // 1. Navigate & Login to JAMB e-facility
        await page.goto('https://efacility.jamb.gov.ng/', { waitUntil: 'networkidle2', timeout: 45000 });

        await page.waitForSelector('input#email, input#Email', { timeout: 15000 });
        await page.type('input#email, input#Email', email, { delay: 30 });
        await page.type('input#password, input#Password', password, { delay: 30 });

        await Promise.all([
            page.click('button[type="submit"], input[type="submit"], #loginButton, button.btn-primary'),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
        ]);

        const isStillOnLogin = await page.$('input#password, input#Password');
        if (isStillOnLogin) {
            await browser.close();
            return res.json({ success: false, message: "Invalid Email or Password. Please check your credentials." });
        }

        await new Promise(r => setTimeout(r, 4000));

        // 2. Extract Candidate Name and Profile Code
        let candidateData = await page.evaluate(() => {
            const bodyText = document.body.innerText || "";
            let name = "Verified Candidate";
            const nameMatch = bodyText.match(/Welcome\s*Back\s*([^\r\n.]+)/i);
            if (nameMatch) name = nameMatch[1].replace(/[.!]/g, '').trim();

            let profileCode = "Not Found";
            const pcMatch = bodyText.match(/Profile\s*Code[:\s]*([0-9]+)/i) || bodyText.match(/\b([0-9][A-Z0-9]{9})\b/);
            if (pcMatch) profileCode = pcMatch[1];

            return { 
                name, 
                profileCode, 
                institution: "Not Yet Loaded in CAPS", 
                course: "Not Yet Loaded in CAPS", 
                status: "⏳ Admission in Progress / Not Admitted Yet" 
            };
        });

        // 3. Click "Check Admission Status"
        try {
            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = els.find(el => el.innerText.trim().toLowerCase().includes('check admission status'));
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 4000));
        } catch (e) {}

        // 4. Click "Access My CAPS" (This usually opens a New Tab)
        try {
            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = els.find(el => el.innerText.trim().toLowerCase().includes('access my caps'));
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 6000)); // Wait for the new tab to spawn and load
        } catch (e) {}

        // CRITICAL FIX: The auto-tab switcher! 
        // We fetch all currently open browser tabs and select the MOST RECENT one.
        const pages = await browser.pages();
        const activePage = pages[pages.length - 1]; 

        // 5. Click "Regular Admission Status" on the new CAPS tab
        try {
            await activePage.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p, li'));
                const target = els.find(el => {
                    const txt = el.innerText.trim().toLowerCase();
                    return txt.includes('admission status') || txt.includes('regular admission');
                });
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 8000)); // Generous wait for the server database to reply
        } catch (e) {}

        // 6. Data Extraction Logic (We scan the active page AND all hidden iframes)
        const extractLogic = () => {
            const bodyText = document.body.innerText || "";
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            let inst = null;
            let crs = null;
            let stat = null;
            const ignoreList = ["application for", "correction", "condonement", "change of", "downward", "not yet loaded"];

            for (let i = 0; i < lines.length; i++) {
                const cur = lines[i].toLowerCase();
                if ((cur.includes('institution') || cur === 'institution:') && lines[i+1]) {
                    const val = lines[i+1];
                    if (!ignoreList.some(ig => val.toLowerCase().includes(ig)) && val.length > 3) inst = val;
                }
                if ((cur.includes('course') || cur.includes('programme')) && lines[i+1] && !cur.includes('subject')) {
                    const val = lines[i+1];
                    if (!ignoreList.some(ig => val.toLowerCase().includes(ig)) && val.length > 3) crs = val;
                }
                if (cur.includes('admission status') && lines[i+1]) {
                    stat = lines[i+1];
                }
            }

            // Fallback Regex in case the table format is tight
            if (!inst) {
                const iMatch = bodyText.match(/Institution[:\s]+([^\n]+)/i);
                if (iMatch && !ignoreList.some(ig => iMatch[1].toLowerCase().includes(ig))) inst = iMatch[1].trim();
            }
            if (!crs) {
                const cMatch = bodyText.match(/(?:Course|Programme)[:\s]+([^\n]+)/i);
                if (cMatch && !ignoreList.some(ig => cMatch[1].toLowerCase().includes(ig))) crs = cMatch[1].trim();
            }

            return { 
                inst, 
                crs, 
                stat: stat || (bodyText.includes("NOT ADMITTED") ? "NOT ADMITTED" : (bodyText.includes("ADMITTED") ? "ADMITTED" : ""))
            };
        };

        let capsFound = false;
        
        // Scan internal frames first (CAPS often drops the result inside an embedded iframe)
        for (const frame of activePage.frames()) {
            try {
                const fData = await frame.evaluate(extractLogic);
                if (fData.inst || fData.crs) {
                    if (fData.inst) candidateData.institution = fData.inst;
                    if (fData.crs) candidateData.course = fData.crs;
                    if (fData.stat) {
                        if (fData.stat.toUpperCase().includes("ADMITTED") && !fData.stat.toUpperCase().includes("NOT")) {
                            candidateData.status = "🎉 ADMISSION OFFERED / APPROVED";
                        } else if (fData.stat.toUpperCase().includes("NOT")) {
                            candidateData.status = "❌ NOT ADMITTED YET";
                        }
                    }
                    capsFound = true;
                    break;
                }
            } catch (e) {}
        }

        // Scan main page if frames missed it
        if (!capsFound) {
            const mData = await activePage.evaluate(extractLogic);
            if (mData.inst) candidateData.institution = mData.inst;
            if (mData.crs) candidateData.course = mData.crs;
            if (mData.stat) {
                if (mData.stat.toUpperCase().includes("ADMITTED") && !mData.stat.toUpperCase().includes("NOT")) {
                    candidateData.status = "🎉 ADMISSION OFFERED / APPROVED";
                } else if (mData.stat.toUpperCase().includes("NOT")) {
                    candidateData.status = "❌ NOT ADMITTED YET";
                }
            }
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
