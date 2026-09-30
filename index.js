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

        // 1. Login to JAMB e-facility
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
                institution: null, 
                course: null, 
                status: null,
                diagnosticReason: "Page loaded, but admission element timed out."
            };
        });

        // 3. Navigate to CAPS ("Check Admission Status" -> "Access My CAPS")
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

        // 4. Switch to the CAPS tab
        const pages = await browser.pages();
        const activePage = pages[pages.length - 1]; 

        // 5. Click the "UTME / DE" Admission Offer link & WAIT FOR THE ELEMENT TO RENDER
        try {
            await activePage.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                const target = links.find(l => (l.href && l.href.includes('candidateadmission.aspx')) || l.innerText.trim().toLowerCase().includes('utme / de'));
                if (target) target.click();
            });

            // Dynamically wait until ASP.NET renders the institution ID label on the page
            await activePage.waitForSelector('#ctl00_MainContent_lblinstName', { timeout: 15000 });
        } catch (e) {
            console.log("Postback wait timeout:", e.message);
        }

        // 6. EXTRACT DATA DIRECTLY BY ID
        const extractData = () => {
            const getElemText = (id) => {
                const el = document.getElementById(id);
                return el ? el.innerText.trim() : null;
            };

            const inst = getElemText('ctl00_MainContent_lblinstName');
            const crs = getElemText('ctl00_MainContent_lblprogramname');
            const stat = getElemText('ctl00_MainContent_lblAdmissionStatus');

            const pageText = document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : "";
            let diagnosticReason = "Successful extraction.";
            if (!inst) {
                if (pageText.includes("Session Expired") || pageText.includes("Log In")) {
                    diagnosticReason = "Session expired or redirected back to login.";
                } else {
                    diagnosticReason = "Institution element IDs not found in DOM after postback.";
                }
            }

            return { inst, crs, stat, diagnosticReason };
        };

        let capsFound = false;

        // Check inside frames
        for (const frame of activePage.frames()) {
            try {
                const fData = await frame.evaluate(extractData);
                if (fData.inst || fData.crs) {
                    candidateData.institution = fData.inst;
                    candidateData.course = fData.crs;
                    candidateData.status = fData.stat;
                    candidateData.diagnosticReason = fData.diagnosticReason;
                    capsFound = true;
                    break;
                }
            } catch (e) {}
        }

        // Check main active page if frames didn't match
        if (!capsFound) {
            const mData = await activePage.evaluate(extractData);
            candidateData.institution = mData.inst;
            candidateData.course = mData.crs;
            candidateData.status = mData.stat;
            candidateData.diagnosticReason = mData.diagnosticReason;
        }

        // Format clean output for WhatsApp
        let finalInstitution = candidateData.institution;
        let finalCourse = candidateData.course;
        let finalStatus = candidateData.status;

        if (!finalInstitution || finalInstitution === "") {
            finalInstitution = `⚠️ Not Showing: ${candidateData.diagnosticReason}`;
        }
        if (!finalCourse || finalCourse === "") {
            finalCourse = "Not Available";
        }
        if (!finalStatus || finalStatus === "") {
            finalStatus = "⏳ Admission in Progress / Not Admitted Yet";
        } else {
            const upperStat = finalStatus.toUpperCase();
            if (upperStat.includes("ADMITTED") && !upperStat.includes("NOT")) {
                finalStatus = "🎉 ADMISSION OFFERED / APPROVED";
            } else if (upperStat.includes("NOT")) {
                finalStatus = "❌ NOT ADMITTED YET";
            }
        }

        candidateData.institution = finalInstitution;
        candidateData.course = finalCourse;
        candidateData.status = finalStatus;

        await browser.close();
        return res.json({ success: true, data: candidateData, message: "Successfully executed check." });

    } catch (error) {
        if (browser) await browser.close();
        console.error("Cloud Scraper Error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper API running on port ${PORT}`));
