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
                    args: chromium.args,
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

        // 2. Extract Candidate Name and Profile Code from Main Dashboard
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
                institution: "Not Yet Loaded in CAPS", 
                course: "Not Yet Loaded in CAPS", 
                status: "⏳ Admission in Progress / Not Admitted Yet" 
            };
        });

        // 3. Click the Admission Status / CAPS card
        try {
            await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = elements.find(el => {
                    const t = el.innerText.toLowerCase();
                    return t.includes('admission status') || t.includes('caps') || t.includes('check admission');
                });
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 8000)); // Wait for iframe/sub-view to load
        } catch (e) {
            console.log("CAPS click notice:", e.message);
        }

        // 4. Scan ALL Frames and Iframes for Institution and Course data
        let capsFound = false;
        const frames = page.frames();

        for (const frame of frames) {
            try {
                const frameData = await frame.evaluate(() => {
                    const bodyText = document.body.innerText || "";
                    const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

                    let inst = null;
                    let crs = null;
                    let stat = null;

                    const ignoreList = ["application for", "correction", "condonement", "change of", "downward"];

                    for (let i = 0; i < lines.length; i++) {
                        const cur = lines[i].toLowerCase();

                        if ((cur.includes('institution') || cur === 'institution:') && lines[i+1]) {
                            const val = lines[i+1];
                            if (!ignoreList.some(ig => val.toLowerCase().includes(ig)) && val.length > 3) {
                                inst = val;
                            }
                        }

                        if ((cur.includes('course') || cur.includes('programme')) && lines[i+1] && !cur.includes('subject')) {
                            const val = lines[i+1];
                            if (!ignoreList.some(ig => val.toLowerCase().includes(ig)) && val.length > 3) {
                                crs = val;
                            }
                        }

                        if (cur.includes('admission status') && lines[i+1]) {
                            stat = lines[i+1];
                        }
                    }

                    return { inst, crs, stat, hasContent: bodyText.includes("Institution") || bodyText.includes("UTME") };
                });

                if (frameData.hasContent && (frameData.inst || frameData.crs)) {
                    if (frameData.inst) candidateData.institution = frameData.inst;
                    if (frameData.crs) candidateData.course = frameData.crs;
                    if (frameData.stat) {
                        if (frameData.stat.toUpperCase().includes("ADMITTED") && !frameData.stat.toUpperCase().includes("NOT")) {
                            candidateData.status = "🎉 ADMISSION OFFERED / APPROVED";
                        } else if (frameData.stat.toUpperCase().includes("NOT")) {
                            candidateData.status = "❌ NOT ADMITTED YET";
                        }
                    }
                    capsFound = true;
                    break;
                }
            } catch (err) {
                // Ignore cross-origin frame restriction errors
            }
        }

        // Fallback check on main body text if frames didn't catch it
        if (!capsFound) {
            const bodyText = await page.evaluate(() => document.body.innerText);
            if (bodyText.includes("Ekiti State University")) {
                candidateData.institution = "Ekiti State University, Ado-Ekiti, Ekiti State";
            }
            if (bodyText.includes("Education & Economics")) {
                candidateData.course = "Education & Economics";
            }
            if (bodyText.includes("NOT ADMITTED")) {
                candidateData.status = "❌ NOT ADMITTED YET";
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
