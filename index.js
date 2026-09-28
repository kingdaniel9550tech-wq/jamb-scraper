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

        await new Promise(r => setTimeout(r, 3000));

        // 2. Extract Candidate Name and Profile Code from Dashboard
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

        // 3. Directly jump to the exact CAPS Admission page using the session cookie!
        try {
            await page.goto('https://caps.jamb.gov.ng/login/app_candidates/candidateadmission.aspx', { 
                waitUntil: 'networkidle2', 
                timeout: 35000 
            });
            await new Promise(r => setTimeout(r, 6000)); // Allow background AJAX to populate rows
        } catch (navErr) {
            console.log("Direct CAPS page goto notice:", navErr.message);
        }

        // 4. Extract Institution, Course, and Status from the target page
        const capsData = await page.evaluate(() => {
            const bodyText = document.body.innerText || "";
            const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            let institution = null;
            let course = null;
            let admissionStatus = null;

            const ignoreList = ["application for", "correction", "condonement", "change of", "downward"];

            for (let i = 0; i < lines.length; i++) {
                const cur = lines[i].toLowerCase();

                if ((cur.includes('institution') || cur === 'institution:') && lines[i+1]) {
                    const val = lines[i+1];
                    if (!ignoreList.some(ig => val.toLowerCase().includes(ig)) && val.length > 3) {
                        institution = val;
                    }
                }

                if ((cur.includes('course') || cur.includes('programme')) && lines[i+1] && !cur.includes('subject')) {
                    const val = lines[i+1];
                    if (!ignoreList.some(ig => val.toLowerCase().includes(ig)) && val.length > 3) {
                        course = val;
                    }
                }

                if (cur.includes('admission status') && lines[i+1]) {
                    admissionStatus = lines[i+1];
                }
            }

            return {
                institution: institution || null,
                course: course || null,
                statusText: admissionStatus || (bodyText.includes("NOT ADMITTED") ? "NOT ADMITTED" : (bodyText.includes("ADMITTED") ? "ADMITTED" : ""))
            };
        });

        if (capsData.institution) candidateData.institution = capsData.institution;
        if (capsData.course) candidateData.course = capsData.course;
        
        if (capsData.statusText.toUpperCase().includes("ADMITTED") && !capsData.statusText.toUpperCase().includes("NOT")) {
            candidateData.status = "🎉 ADMISSION OFFERED / APPROVED";
        } else if (capsData.statusText.toUpperCase().includes("NOT")) {
            candidateData.status = "❌ NOT ADMITTED YET";
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
