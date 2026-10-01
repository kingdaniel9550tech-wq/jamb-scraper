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

        // Wait for dashboard to fully load
        await new Promise(r => setTimeout(r, 6000));

        // 2. Extract Candidate Name and Profile Code from dashboard
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
                diagnosticReason: "Dashboard card search completed."
            };
        });

        // 3. TARGETED DASHBOARD NAVIGATION: Search and click "Check Admission Status" or "CAPS" card/tile
        let dashboardElements = [];
        try {
            const navResult = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('a, button, div, span, h3, h4, .card, .tile'));
                let foundUrl = null;
                let foundTexts = [];

                elements.forEach(el => {
                    const txt = el.innerText ? el.innerText.trim().replace(/\s+/g, ' ') : '';
                    const href = el.getAttribute('href') || el.getAttribute('onclick') || '';
                    if (txt && txt.length > 2 && txt.length < 60) {
                        foundTexts.push(txt);
                    }

                    const lowerTxt = txt.toLowerCase();
                    const lowerHref = href.toLowerCase();

                    if (
                        lowerTxt.includes('check admission status') || 
                        lowerTxt.includes('admission & caps') || 
                        lowerTxt.includes('caps') ||
                        lowerHref.includes('candidateadmission') ||
                        lowerHref.includes('caps')
                    ) {
                        if (el.tagName === 'A' && el.href) {
                            foundUrl = el.href;
                        } else {
                            const clickable = el.closest('a') || el.closest('button') || el.closest('.card') || el;
                            if (clickable && typeof clickable.click === 'function') {
                                clickable.click();
                            }
                        }
                    }
                });

                return { foundUrl, foundTexts: Array.from(new Set(foundTexts)).slice(0, 30) };
            });

            dashboardElements = navResult.foundTexts;

            if (navResult.foundUrl) {
                await page.goto(navResult.foundUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            }
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) {}

        // 4. Fallback: Direct navigation to candidate admission if tile click didn't redirect
        try {
            const currentUrl = page.url();
            if (!currentUrl.toLowerCase().includes('admission') && !currentUrl.toLowerCase().includes('caps')) {
                await page.goto('https://efacility.jamb.gov.ng/CandidateAdmission', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            }
        } catch (e) {}

        // 5. Click "Access My CAPS" if present on sub-page
        try {
            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = els.find(el => {
                    const txt = el.innerText.trim().toLowerCase();
                    return txt.includes('access my caps') || txt.includes('caps');
                });
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 6000)); 
        } catch (e) {}

        // 6. Switch to active tab/page if opened in new window/tab
        const pages = await browser.pages();
        const activePage = pages[pages.length - 1]; 

        // 7. Frame-Aware Polling (Up to 25 seconds) for admission table elements
        let elementFound = false;
        let attempts = 25;
        while (attempts > 0 && !elementFound) {
            for (const frame of activePage.frames()) {
                try {
                    const el = await frame.$('#ctl00_MainContent_lblinstName');
                    if (el) {
                        elementFound = true;
                        break;
                    }
                } catch (e) {}
            }
            if (!elementFound) {
                await new Promise(r => setTimeout(r, 1000));
                attempts--;
            }
        }

        // 8. Extract data from frames or page
        const extractData = () => {
            const getElemText = (id) => {
                const el = document.getElementById(id);
                return el ? el.innerText.trim() : null;
            };

            const inst = getElemText('ctl00_MainContent_lblinstName');
            const crs = getElemText('ctl00_MainContent_lblprogramname');
            const stat = getElemText('ctl00_MainContent_lblAdmissionStatus');

            return { inst, crs, stat };
        };

        let capsFound = false;
        for (const frame of activePage.frames()) {
            try {
                const fData = await frame.evaluate(extractData);
                if (fData.inst || fData.crs) {
                    candidateData.institution = fData.inst;
                    candidateData.course = fData.crs;
                    candidateData.status = fData.stat;
                    capsFound = true;
                    break;
                }
            } catch (e) {}
        }

        if (!capsFound) {
            try {
                const mData = await activePage.evaluate(extractData);
                if (mData.inst) {
                    candidateData.institution = mData.inst;
                    candidateData.course = mData.crs;
                    candidateData.status = mData.stat;
                    capsFound = true;
                }
            } catch (e) {}
        }

        if (!capsFound) {
            candidateData.diagnosticReason = `Dashboard elements detected: [${dashboardElements.slice(0, 10).join(', ')}]`;
        }

        // Format clean output for WhatsApp bot
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
