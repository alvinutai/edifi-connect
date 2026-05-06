/**
 * EDiFi Connect — Session Scraper
 *
 * Unlike the cloud scraper which handles login/MFA, this scraper receives
 * cookies from an ALREADY AUTHENTICATED portal session (captured by the
 * Chrome extension when office staff logged in normally).
 *
 * Flow:
 *   1. Load captured session cookies into Playwright context
 *   2. Navigate DIRECTLY to the eligibility search page (no login needed)
 *   3. Fill member ID, search, extract benefits with Claude AI
 *
 * Why this works:
 *   - Portal sees the office's real IP (not Railway datacenter)
 *   - Cookies prove authentication — no login, no MFA
 *   - Behavioral AI sees a real session continuation, not a fresh login
 */

const { chromium } = require('playwright');

// Direct eligibility page URLs per carrier (skip homepage → login flow)
const ELIGIBILITY_URLS = {
  DDIC:        'https://www1.deltadentalins.com/providers/patient-eligibility',
  DDCA:        'https://dentist.deltadental.com/app/eligibility',
  DOT:         'https://www.dentalofficetoolkit.com/dot-ui/eligibility',
  METLIFE:     'https://dental.provider.metlife.com/eligibility',
  CIGNA:       'https://cignaforhcp.cigna.com/app/eligibility',
  AETNA:       'https://www.aetna.com/health-care-professionals/provider-information/patient-eligibility',
  UHC:         'https://www.uhcprovider.com/en/claims-payments-prior-auths/prior-auth-notification/eligibility-overview.html',
  GUARDIAN:    'https://www.guardianlife.com/dental-insurance/providers/verify-eligibility',
  SELECTHEALTH: 'https://selecthealth.org/provider/eligibility',
  EMIHEALTH:   'https://www.emihealth.com/providers/eligibility',
  DDWA:        'https://www.deltadentalwa.com/provider/eligibility',
  DDIL:        'https://www3.deltadentalil.com/dentist/eligibility',
};

// Member ID field selectors per carrier
const MEMBER_FIELD_SELECTORS = [
  '#memberId', '#member-id', '#subscriberId',
  'input[name="memberId"]', 'input[name="memberID"]', 'input[name="subscriberId"]',
  'input[name="member_id"]', 'input[name="memberNumber"]',
  'input[placeholder*="Member" i]', 'input[placeholder*="Subscriber" i]',
  'input[placeholder*="ID" i]',
];

// Search/submit button selectors
const SEARCH_BTN_SELECTORS = [
  'button:has-text("Search")', 'button:has-text("Check Eligibility")',
  'button:has-text("Verify")', 'button:has-text("Submit")',
  'button[type="submit"]', '#search-btn', '#verify-btn',
];

class SessionScraper {
  /**
   * Scrapes eligibility data using a pre-authenticated session.
   *
   * @param {object} opts
   * @param {string} opts.payer_code - Payer identifier (DDIC, METLIFE, etc.)
   * @param {Array} opts.cookies - Cookies from the Chrome extension
   * @param {string} opts.member_id - Patient member/subscriber ID
   * @param {string} opts.subscriber_dob - Date of birth (YYYY-MM-DD)
   * @param {string} opts.subscriber_last_name - Subscriber last name
   * @param {string} [opts.group_number] - Group number (optional)
   */
  async scrape({ payer_code, cookies, member_id, subscriber_dob, subscriber_last_name, group_number }) {
    const eligibilityUrl = ELIGIBILITY_URLS[payer_code];
    if (!eligibilityUrl) {
      throw new Error(`No eligibility URL configured for payer ${payer_code}`);
    }

    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      });

      // Load session cookies — this is what makes login unnecessary
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
        timezoneId: 'America/Denver',
      });

      // Inject the captured session cookies
      const cookiesToAdd = cookies
        .filter(c => c.value && c.name)
        .map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
          path: c.path || '/',
          secure: c.secure || false,
          httpOnly: c.httpOnly || false,
          sameSite: c.sameSite || 'Lax',
          expires: c.expirationDate || -1,
        }));

      await context.addCookies(cookiesToAdd);

      const page = await context.newPage();
      page.setDefaultTimeout(25000);

      // Navigate directly to eligibility page — no login needed
      const response = await page.goto(eligibilityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // If redirected to login page, session has expired
      const currentUrl = page.url().toLowerCase();
      if (currentUrl.includes('/login') || currentUrl.includes('/signin') ||
          currentUrl.includes('/ciam/login') || currentUrl.includes('okta.com/login')) {
        throw new Error('SESSION_EXPIRED: Session cookies have expired. Office staff needs to log into the portal again.');
      }

      if (!response?.ok()) {
        throw new Error(`Portal returned HTTP ${response?.status()} — may need re-authentication`);
      }

      // Wait for eligibility form to load
      await page.waitForSelector(MEMBER_FIELD_SELECTORS.join(', '), { state: 'visible', timeout: 15000 });

      // Fill member ID
      const memberField = page.locator(MEMBER_FIELD_SELECTORS.join(', ')).first();
      await memberField.click();
      await page.waitForTimeout(300);
      await memberField.fill(member_id);

      // Fill DOB if field exists
      if (subscriber_dob) {
        const dobField = page.locator([
          '#dateOfBirth', 'input[name="dateOfBirth"]', 'input[name="dob"]',
          'input[name="birthDate"]', 'input[placeholder*="Date of Birth" i]',
        ].join(', ')).first();
        const hasDob = await dobField.isVisible({ timeout: 2000 }).catch(() => false);
        if (hasDob) {
          const [y, m, d] = subscriber_dob.split('-');
          await dobField.fill(`${m}/${d}/${y}`);
        }
      }

      // Fill last name if field exists
      if (subscriber_last_name) {
        const lastNameField = page.locator([
          '#lastName', 'input[name="lastName"]', 'input[name="last_name"]',
          'input[placeholder*="Last Name" i]',
        ].join(', ')).first();
        const hasLastName = await lastNameField.isVisible({ timeout: 2000 }).catch(() => false);
        if (hasLastName) await lastNameField.fill(subscriber_last_name);
      }

      // Submit search
      const searchBtn = page.locator(SEARCH_BTN_SELECTORS.join(', ')).first();
      await searchBtn.waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForTimeout(400);
      await searchBtn.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});

      // Extract with Claude AI (same as cloud scraper)
      const pageText = await page.innerText('body');
      const benefits = await this.extractWithClaude(pageText, payer_code);

      return benefits;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  async extractWithClaude(pageText, payerCode) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Return raw text if no Claude key — cloud scraper will re-extract
      return { raw_text: pageText.slice(0, 50000), benefits: [] };
    }

    // Dynamic import for ESM-compatible environments
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Extract dental insurance benefit information from this ${payerCode} provider portal page.
Return JSON with: eligibility_status (ACTIVE/INACTIVE/UNKNOWN), plan_name, group_number,
individual_deductible_cents, individual_deductible_remaining_cents, annual_maximum_cents,
annual_maximum_remaining_cents, benefit_year_type (CALENDAR/PLAN/UNKNOWN), missing_tooth_clause (bool),
and benefits array with: category, is_covered, in_network_percent, frequency_limit, waiting_period_months.

Page content:
---
${pageText.slice(0, 60000)}
---`,
      }],
    });

    try {
      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {}

    return { raw_text: pageText.slice(0, 50000), benefits: [] };
  }
}

module.exports = { SessionScraper };
