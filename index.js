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

        // 4. PRECISE DOM EXTRACTION
        const extractLogic = () => {
            let inst = null;
            let crs = null;
            let stat = null;

            // Search all elements on the page
            const allElements = Array.from(document.querySelectorAll('*'));

            for (const el of allElements) {
                const text = el.innerText ? el.innerText.trim() : "";

                // Look for element whose immediate text is "Institution:" or starts with "Institution"
                if (/^institution\s*:?$/i.test(text)) {
                    // Try next element sibling
                    if (el.nextElementSibling && el.nextElementSibling.innerText) {
                        const val = el.nextElementSibling.innerText.trim();
                        if (val && !val.toLowerCase().includes('transferred')) inst = val;
                    }
                    // Or check parent/sibling structure
                    if (!inst && el.parentElement) {
                        const siblings = Array.from(el.parentElement.children);
                        const idx = siblings.indexOf(el);
                        if (idx !== -1 && siblings[idx + 1]) {
                            const val = siblings[idx + 1].innerText.trim();
                            if (val && !val.toLowerCase().includes('transferred')) inst = val;
                        }
                    }
                }

                // Look for "Course :"
                if (/^course\s*:?$/i.test(text) \vert{}\vert{} /^programme\s*:?$/i.test(text)) {
                    if (el.nextElementSibling && el.nextElementSibling.innerText) {
                        crs = el.nextElementSibling.innerText.trim();
                    }
                    if (!crs && el.parentElement) {
                        const siblings = Array.from(el.parentElement.children);
                        const idx = siblings.indexOf(el);
                        if (idx !== -1 && siblings[idx + 1]) {
                            crs = siblings[idx + 1].innerText.trim();
                        }
                    }
                }

                // Look for "Admission Status:"
                if (/^admission status\s*:?$/i.test(text)) {
                    if (el.nextElementSibling && el.nextElementSibling.innerText) {
                        stat = el.nextElementSibling.innerText.trim();
                    }
                    if (!stat && el.parentElement) {
                        const siblings = Array.from(el.parentElement.children);
                        const idx = siblings.indexOf(el);
                        if (idx !== -1 && siblings[idx + 1]) {
                            stat = siblings[idx + 1].innerText.trim();
                        }
                    }
                }
            }

            // Fallback: Exact plain-text line scanning
            if (!inst || !crs) {
                const lines = (document.body.innerText || "").split('\n').map(l => l.trim()).filter(Boolean);
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].toLowerCase();
                    if (line === 'institution:' || line === 'institution') {
                        if (lines[i + 1] && !lines[i + 1].toLowerCase().includes('transferred')) {
                            if (!inst) inst = lines[i + 1];
                        }
                    }
                    if (line === 'course:' || line === 'course' || line === 'programme:' || line === 'programme') {
                        if (lines[i + 1]) {
                            if (!crs) crs = lines[i + 1];
                        }
                    }
                    if (line === 'admission status:' || line === 'admission status') {
                        if (lines[i + 1]) {
                            if (!stat) stat = lines[i + 1];
                        }
                    }
                }
            }

            return { inst, crs, stat };
        };

        let capsFound = false;

        // Scan frames
        for (const frame of activePage.frames()) {
            try {
                const fData = await frame.evaluate(extractLogic);
                if (fData.inst || fData.crs) {
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

        // Scan main active page if frame didn't yield values
        if (!capsFound) {
            const mData = await activePage.evaluate(extractLogic);
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
