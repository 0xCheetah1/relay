const sections = [...document.querySelectorAll('.section, .hero')];
for (const section of sections) section.classList.add('reveal');

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add('visible');
    observer.unobserve(entry.target);
  }
}, { threshold: 0.08, rootMargin: '0px 0px -8% 0px' });

for (const section of sections) observer.observe(section);

// Highlight the section currently in view in the nav.
const navLinks = [...document.querySelectorAll('.nav nav a')];
const targets = navLinks
  .map((link) => document.querySelector(link.getAttribute('href')))
  .filter(Boolean);

const navObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    for (const link of navLinks) {
      const active = link.getAttribute('href') === `#${entry.target.id}`;
      link.style.color = active ? 'var(--paper)' : '';
    }
  }
}, { rootMargin: '-45% 0px -45% 0px' });

for (const target of targets) navObserver.observe(target);

const installTabs = [...document.querySelectorAll('.install-tab')];
function selectInstallTab(tab) {
  for (const candidate of installTabs) {
    const selected = candidate === tab;
    candidate.classList.toggle('is-active', selected);
    candidate.setAttribute('aria-selected', String(selected));
    const panel = document.getElementById(candidate.getAttribute('aria-controls'));
    if (panel) panel.hidden = !selected;
  }
}
for (const tab of installTabs) {
  tab.addEventListener('click', () => selectInstallTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = installTabs.indexOf(tab);
    const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + installTabs.length) % installTabs.length;
    const next = installTabs[nextIndex];
    next.focus();
    selectInstallTab(next);
  });
}

const nearLookupForm = document.querySelector('#near-lookup-form');
if (nearLookupForm) {
  nearLookupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.querySelector('#near-lookup-id');
    const output = document.querySelector('#near-lookup-result');
    const relayId = input.value.trim();
    output.className = 'near-lookup-result';
    if (!/^rly_[0-9a-f-]{36}$/.test(relayId)) {
      output.classList.add('error');
      output.textContent = 'Enter a relay ID like rly_00000000-0000-4000-8000-000000000000.';
      return;
    }
    output.textContent = 'Resolving…';
    const lookupBase = location.hostname.endsWith('thecheetah11.com')
      ? 'https://relay.thecheetah11.com/near-lookup/'
      : '/near-lookup/';
    try {
      const response = await fetch(`${lookupBase}${encodeURIComponent(relayId)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error === 'not_found'
          ? 'No NEAR account is published for that relay ID yet.'
          : 'NEAR lookup failed. Try again.');
      }
      output.classList.add('ok');
      output.textContent = `${data.relayId} → ${data.account}`;
    } catch (error) {
      output.classList.add('error');
      output.textContent = error.message;
    }
  });
}

for (const button of document.querySelectorAll('.copy-button[data-copy]')) {
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    const text = target.textContent.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    const label = button.textContent;
    button.textContent = 'Copied';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove('copied');
    }, 1600);
  });
}
