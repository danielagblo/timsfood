(function () {
  const root = document.querySelector("[data-hero-pin]");
  const track = document.querySelector(".hero-track");
  const rail = document.querySelector(".hero-rail");
  if (!root || !track || !rail || !window.gsap || !window.ScrollTrigger) return;

  const gsap = window.gsap;
  gsap.registerPlugin(window.ScrollTrigger);
  const jars = gsap.utils.toArray(".hero-track .jar");
  if (!jars.length) return;

  const header = document.querySelector(".site-header");
  const headerOffset = () => (header ? header.offsetHeight : 0);

  const centerX = (index) => {
    const jar = jars[index];
    return rail.clientWidth / 2 - (jar.offsetLeft + jar.offsetWidth / 2);
  };

  const scaleFromCenter = () => {
    const mid = window.innerWidth / 2;
    const reach = Math.max(window.innerWidth * 0.38, 180);
    jars.forEach((jar) => {
      const box = jar.getBoundingClientRect();
      const dist = Math.abs(box.left + box.width / 2 - mid);
      const t = gsap.utils.clamp(0, 1, 1 - dist / reach);
      gsap.set(jar, {
        scale: 0.78 + t * 0.42,
        zIndex: Math.round(2 + t * 20)
      });
    });
  };

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    gsap.set(track, { x: centerX(Math.floor(jars.length / 2)) });
    scaleFromCenter();
    return;
  }

  gsap.fromTo(
    track,
    { x: () => centerX(0) },
    {
      x: () => centerX(jars.length - 1),
      ease: "none",
      onUpdate: scaleFromCenter,
      onStart: scaleFromCenter,
      scrollTrigger: {
        trigger: root,
        start: () => `top ${headerOffset()}px`,
        end: () => `+=${Math.round(Math.max(window.innerHeight * 1.8, 900))}`,
        pin: true,
        pinSpacing: true,
        scrub: 0.7,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onRefresh: scaleFromCenter
      }
    }
  );

  scaleFromCenter();
  window.addEventListener("resize", () => window.ScrollTrigger.refresh());
})();
