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

        // 1. Login
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

        // 2. Candidate Info from main dashboard
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

        // 3. Navigate to CAPS
        try {
            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = els.find(el => el.innerText.trim().toLowerCase().includes('check admission status'));
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 4000));
        } catch (e) {}

        try {
            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = els.find(el => el.innerText.trim().toLowerCase().includes('access my caps'));
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 6000)); 
        } catch (e) {}

        const pages = await browser.pages();
        const activePage = pages[pages.length - 1]; 

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

        // 4. DIRECT ID-BASED EXTRACTION FROM HTML DOM
        const extractByIDs = () => {
            const getElemText = (id) => {
                const el = document.getElementById(id);
                return el ? el.innerText.trim() : null;
            };

            return {
                inst: getElemText('ctl00_MainContent_lblinstName'),
                crs: getElemText('ctl00_MainContent_lblprogramname'),
                stat: getElemText('ctl00_MainContent_lblAdmissionStatus')
            };
        };

        let capsFound = false;

        // Check inside all frames
        for (const frame of activePage.frames()) {
            try {
                const fData = await frame.evaluate(extractByIDs);
                if (fData.inst || fData.crs || fData.stat) {
                    if (fData.inst) candidateData.institution = fData.inst;
                    if (fData.crs) candidateData.course = fData.crs;
                    if (fData.stat) {
                        const upperStat = fData.stat.toUpperCase();
                        if (upperStat.includes("ADMITTED") && !upperStat.includes("NOT")) {
                            candidateData.status = "🎉 ADMISSION OFFERED / APPROVED";
                        } else if (upperStat.includes("NOT")) {
                            candidateData.status = "❌ NOT ADMITTED YET";
                        } else {
                            candidateData.status = fData.stat;
                        }
                    }
                    capsFound = true;
                    break;
                }
            } catch (e) {}
        }

        // Check main active page if frames didn't match
        if (!capsFound) {
            const mData = await activePage.evaluate(extractByIDs);
            if (mData.inst) candidateData.institution = mData.inst;
            if (mData.crs) candidateData.course = mData.crs;
            if (mData.stat) {
                const upperStat = mData.stat.toUpperCase();
                if (upperStat.includes("ADMITTED") && !upperStat.includes("NOT")) {
                    candidateData.status = "🎉 ADMISSION OFFERED / APPROVED";
                } else if (upperStat.includes("NOT")) {
                    candidateData.status = "❌ NOT ADMITTED YET";
                } else {
                    candidateData.status = mData.stat;
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
