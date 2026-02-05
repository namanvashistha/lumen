// Paste this in the browser console (F12) when on a LinkedIn profile page
// This will show exactly what the extension is seeing

console.log('=== LUMEN DEBUG TEST ===');

// 1. Check URL
console.log('Current URL:', window.location.href);
console.log('Is profile URL?', window.location.href.includes('/in/'));

// 2. Check page content
console.log('Body exists?', !!document.body);
console.log('Body text length:', document.body?.innerText?.length || 0);
console.log('Has h1?', !!document.querySelector('h1'));

// 3. Test all contact button selectors
const contactButtonSelectors = [
  'a[href*="/overlay/contact-info"]',
  '#top-card-text-details-contact-info',
  'a[data-control-name="contact_see_more"]',
  '.pv-text-details__separator + a',
  '[data-test-id="contact-info-cta"]',
  'a[href*="contact-info"]',
];

console.log('\n=== CONTACT BUTTON SEARCH ===');
contactButtonSelectors.forEach((selector, i) => {
  const found = document.querySelector(selector);
  console.log(`${i+1}. ${selector}`);
  console.log('   Found:', !!found);
  if (found) {
    console.log('   Element:', found);
    console.log('   Text:', found.textContent.trim());
  }
});

// 4. Check profile page indicators
const profileSelectors = [
  '.pv-top-card',
  '[data-test-id="profile-top-card"]',
  '.profile-rail-card',
  'main[class*="profile"]',
  'section.artdeco-card',
];

console.log('\n=== PROFILE PAGE INDICATORS ===');
profileSelectors.forEach((selector, i) => {
  const found = document.querySelector(selector);
  console.log(`${i+1}. ${selector}: ${!!found}`);
});

// 5. Check for common profile keywords
const bodyText = document.body?.innerText || '';
console.log('\n=== PROFILE KEYWORDS ===');
console.log('Has "Activity":', bodyText.includes('Activity'));
console.log('Has "Experience":', bodyText.includes('Experience'));
console.log('Has "About":', bodyText.includes('About'));
console.log('Has "Contact info":', bodyText.includes('Contact info'));

// 6. Find all links with "contact" in text or href
console.log('\n=== ALL CONTACT-RELATED LINKS ===');
const allLinks = Array.from(document.querySelectorAll('a'));
const contactLinks = allLinks.filter(a => 
  a.textContent.toLowerCase().includes('contact') || 
  a.href.toLowerCase().includes('contact')
);
console.log('Found', contactLinks.length, 'contact-related links:');
contactLinks.forEach((link, i) => {
  console.log(`${i+1}. Text: "${link.textContent.trim()}" | Href: ${link.href}`);
});

console.log('\n=== END DEBUG TEST ===');
console.log('Copy all output above and share with developer');
