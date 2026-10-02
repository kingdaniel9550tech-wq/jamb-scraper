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
        await page.setViewport({ width: 1366, height: 768 });
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
                diagnosticReason: "Executing CAPS Sidebar PostBack."
            };
        });

        // 3. Scroll down and click the purple "Check Admission Status" card
        try {
            await page.evaluate(async () => {
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise(r => setTimeout(r, 2000));

                const elements = Array.from(document.querySelectorAll('a, button, div, span, h3, h4, p'));
                const target = elements.find(el => {
                    const txt = el.innerText ? el.innerText.trim().toLowerCase() : '';
                    return txt === 'check admission status' || txt.includes('check admission status');
                });

                if (target) {
                    const clickable = target.closest('a') || target.closest('button') || target.closest('div[onclick]') || target;
                    clickable.click();
                }
            });
            
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) {}

        // 4. Click "Access My CAPS" if present on the landing sub-page
        try {
            await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('a, button, div, span, h4, p'));
                const target = els.find(el => {
                    const txt = el.innerText ? el.innerText.trim().toLowerCase() : '';
                    return txt.includes('access my caps') || txt.includes('caps');
                });
                if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 5000)); 
        } catch (e) {}

        // 5. Switch to active tab/page if opened in a new window/tab
        const pages = await browser.pages();
        const activePage = pages[pages.length - 1]; 

        // 6. CAPS SIDEBAR POSTBACK: Evaluate exact doPostBack script for "Admission offer"
        let postBackDebug = "PostBack execution attempted.";
        try {
            postBackDebug = await activePage.evaluate(async () => {
                const elements = Array.from(document.querySelectorAll('a, span, div, button, li, p'));
                const target = elements.find(el => {
                    const txt = el.innerText ? el.innerText.trim().toLowerCase() : '';
                    return txt === 'admission offer';
                });

                if (target) {
                    const anchor = target.closest('a') || target;
                    const href = anchor.getAttribute('href') || '';
                    const onclick = anchor.getAttribute('onclick') || '';

                    if (href.startsWith('javascript:__doPostBack')) {
                        const funcCall = href.replace('javascript:', '');
                        eval(funcCall);
                        return `Executed doPostBack from href: ${href}`;
                    } else if (onclick && onclick.includes('__doPostBack')) {
                        eval(onclick);
                        return `Executed doPostBack from onclick: ${onclick}`;
                    } else {
                        // Search inside parent/child elements for doPostBack
                        const pbEl = target.querySelector('[href*="__doPostBack"]') || target.closest('[href*="__doPostBack"]');
                        if (pbEl) {
                            const pbHref = pbEl.getAttribute('href');
                            eval(pbHref.replace('javascript:', ''));
                            return `Executed nested doPostBack: ${pbHref}`;
                        } else {
                            anchor.click();
                            return `Standard click executed on Admission offer item.`;
                        }
                    }
                }
                return "Admission offer sidebar item not located.";
            });

            await Promise.race([
                activePage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }).catch(() => {}),
                new Promise(r => setTimeout(r, 8000))
            ]);
        } catch (e) {
            postBackDebug = "PostBack error: " + e.message;
        }

        // 7. Frame-Aware Polling (Up to 25 seconds for slow JAMB servers)
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

        // 8. Extract data directly by ID
        const extractData = () => {
            const getElemText = (id) => {
                const el = document.getElementById(id);
                return el ? el.innerText.trim() : null;
            };

            const inst = getElemText('ctl00_MainContent_lblinstName');
            const crs = getElemText('ctl00_MainContent_lblprogramname');
            const stat = getElemTest('ctl00_MainContent_lblAdmissionStatus');

            let pageTexts = [];
            if (!inst) {
                const items = document.querySelectorAll('a, span, div, h3, h4, td');
                items.forEach(i => {
                    const t = i.innerText ? i.innerText.trim() : '';
                    if (t.length > 2 && t.length < 60 && !pageTexts.includes(t)) pageTexts.push(t);
                });
            }

            return { inst, crs, stat, pageTexts: pageTexts.slice(0, 10) };
        };

        let capsFound = false;
        let diagnosticDetails = postBackDebug;

        for (const frame of activePage.frames()) {
            try {
                const fData = await frame.evaluate(extractData);
                if (fData.inst || fData.crs) {
                    candidateData.institution = fData.inst;
                    candidateData.course = fData.crs;
                    candidateData.status = fData.stat;
                    capsFound = true;
                    break;
                } else if (fData.pageTexts && fData.pageTexts.length > 0) {
                    diagnosticDetails = `${postBackDebug} | Frame Texts: [${fData.pageTexts.join(', ')}]`;
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
                } else if (mData.pageTexts && mData.pageTexts.length > 0) {
                    diagnosticDetails = `${postBackDebug} | Page Texts: [${mData.pageTexts.join(', ')}]`;
                }
            } catch (e) {}
        }

        candidateData.diagnosticReason = diagnosticDetails;

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
