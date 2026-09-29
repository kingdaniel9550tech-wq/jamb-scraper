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

        // 4. Click "Access My CAPS" (Spawns New Tab)
        try {
            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = els.find(el => el.innerText.trim().toLowerCase().includes('access my caps'));
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 6000)); 
        } catch (e) {}

        // 5. Switch to the new CAPS tab
        const pages = await browser.pages();
        const activePage = pages[pages.length - 1]; 

        // 6. Click "Admission Status" on the left menu
        try {
            await activePage.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p, li'));
                const target = els.find(el => {
                    const txt = el.innerText.trim().toLowerCase();
                    return txt === 'admission status' || txt === 'regular admission status';
                });
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 8000)); 
        } catch (e) {}

        // 7. ULTRA-AGGRESSIVE DATA EXTRACTION
        const extractLogic = () => {
            const bodyText = document.body.innerText || "";
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            let inst = null;
            let crs = null;
            let stat = null;
            
            // Ignore list for sidebar junk
            const ignoreList = [
                "application for", "correction", "condonement", "change of", 
                "downward", "not yet loaded", "transferred", "transfer", 
                "approval", "caps", "dashboard", "print", "status"
            ];

            const cleanValue = (val) => {
                if (!val) return null;
                const lower = val.toLowerCase();
                if (ignoreList.some(ig => lower.includes(ig))) return null;
                if (val.length < 4) return null;
                return val;
            };

            for (let i = 0; i < lines.length; i++) {
                const cur = lines[i].toLowerCase();
                const originalLine = lines[i];
                
                // --- PARSE INSTITUTION ---
                if (cur.includes('institution') && !cur.includes('transferred')) {
                    // Check if they are on the SAME line (e.g., "Institution: University of Lagos")
                    const splitVal = originalLine.split(/institution[\s:]+/i);
                    if (splitVal.length > 1 && splitVal[1].trim().length > 3) {
                        inst = cleanValue(splitVal[1].trim());
                    } 
                    // Otherwise, check the NEXT line
                    else if (lines[i+1]) {
                        inst = cleanValue(lines[i+1]);
                    }
                }
                
                // --- PARSE COURSE ---
                if ((cur.includes('course') || cur.includes('programme')) && !cur.includes('subject')) {
                    const splitVal = originalLine.split(/(?:course|programme)[\s:]+/i);
                    if (splitVal.length > 1 && splitVal[1].trim().length > 3) {
                        crs = cleanValue(splitVal[1].trim());
                    }
                    else if (lines[i+1]) {
                        crs = cleanValue(lines[i+1]);
                    }
                }
                
                // --- PARSE STATUS ---
                if (cur.includes('admission status') && !cur.includes('regular')) {
                    const splitVal = originalLine.split(/admission status[\s:]+/i);
                    if (splitVal.length > 1 && splitVal[1].trim().length > 3) {
                        stat = splitVal[1].trim();
                    }
                    else if (lines[i+1]) {
                        stat = lines[i+1];
                    }
                }
            }

            return { 
                inst, 
                crs, 
                stat: stat || (bodyText.includes("NOT ADMITTED") ? "NOT ADMITTED" : (bodyText.includes("ADMITTED") ? "ADMITTED" : ""))
            };
        };

        let capsFound = false;
        
        // Scan inside iframes first
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

        // Scan main page if iframes didn't have it
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
