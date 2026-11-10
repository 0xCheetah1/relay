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
