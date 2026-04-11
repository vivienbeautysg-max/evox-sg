(function() {
    "use strict";

    // Sticky navbar
    const navbar = document.getElementById("navbar");
    let lastScroll = 0;
    window.addEventListener("scroll", function() {
        const currentScroll = window.pageYOffset;
        if (currentScroll > 50) {
            navbar.classList.add("scrolled");
        } else {
            navbar.classList.remove("scrolled");
        }
        lastScroll = currentScroll;
    });

    // Hamburger menu
    const hamburger = document.getElementById("hamburger");
    const navLinks = document.getElementById("navLinks");
    hamburger.addEventListener("click", function() {
        hamburger.classList.toggle("active");
        navLinks.classList.toggle("active");
    });

    // Close mobile menu on link click
    document.querySelectorAll(".nav-links a").forEach(function(link) {
        link.addEventListener("click", function() {
            hamburger.classList.remove("active");
            navLinks.classList.remove("active");
        });
    });

    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(function(anchor) {
        anchor.addEventListener("click", function(e) {
            e.preventDefault();
            var target = document.querySelector(this.getAttribute("href"));
            if (target) {
                target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        });
    });

    // Intersection Observer for fade-in animations
    var fadeEls = document.querySelectorAll(".fade-in");
    var fadeObserver = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
            if (entry.isIntersecting) {
                entry.target.classList.add("visible");
                fadeObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });
    fadeEls.forEach(function(el) { fadeObserver.observe(el); });

    // Animated stat counters
    var statNumbers = document.querySelectorAll(".stat-number[data-target]");
    var statObserver = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
            if (entry.isIntersecting) {
                animateCounter(entry.target);
                statObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.5 });
    statNumbers.forEach(function(el) { statObserver.observe(el); });

    function animateCounter(el) {
        var target = parseFloat(el.getAttribute("data-target"));
        var prefix = el.getAttribute("data-prefix") || "";
        var suffix = el.getAttribute("data-suffix") || "";
        var duration = 1500;
        var startTime = null;
        var isDecimal = target % 1 !== 0;

        function step(timestamp) {
            if (!startTime) startTime = timestamp;
            var progress = Math.min((timestamp - startTime) / duration, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            var current = eased * target;
            if (isDecimal) {
                el.textContent = prefix + current.toFixed(2) + suffix;
            } else {
                el.textContent = prefix + Math.floor(current) + suffix;
            }
            if (progress < 1) {
                requestAnimationFrame(step);
            }
        }
        requestAnimationFrame(step);
    }

    // Contact form validation
    var form = document.getElementById("contactForm");
    if (form) {
        form.addEventListener("submit", function(e) {
            e.preventDefault();
            var valid = true;
            var name = document.getElementById("name");
            var email = document.getElementById("email");
            var phone = document.getElementById("phone");

            // Reset
            document.querySelectorAll(".form-group").forEach(function(g) {
                g.classList.remove("error");
            });

            if (!name.value.trim()) {
                name.closest(".form-group").classList.add("error");
                valid = false;
            }
            if (!email.value.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
                email.closest(".form-group").classList.add("error");
                valid = false;
            }
            if (!phone.value.trim()) {
                phone.closest(".form-group").classList.add("error");
                valid = false;
            }

            if (valid) {
                var btnText = form.querySelector(".btn-text");
                var btnLoading = form.querySelector(".btn-loading");
                var submitBtn = form.querySelector('button[type="submit"]');
                btnText.style.display = "none";
                btnLoading.style.display = "inline";
                submitBtn.disabled = true;

                // Simulate send (replace with actual endpoint)
                setTimeout(function() {
                    btnText.textContent = "Request Sent!";
                    btnText.style.display = "inline";
                    btnLoading.style.display = "none";
                    submitBtn.style.background = "#2fd152";
                    form.reset();

                    setTimeout(function() {
                        btnText.textContent = "Send Request";
                        submitBtn.disabled = false;
                        submitBtn.style.background = "";
                    }, 3000);
                }, 1500);
            }
        });
    }

    // Active nav link on scroll
    var sections = document.querySelectorAll("section[id]");
    window.addEventListener("scroll", function() {
        var scrollY = window.pageYOffset + 100;
        sections.forEach(function(sec) {
            var top = sec.offsetTop;
            var height = sec.offsetHeight;
            var id = sec.getAttribute("id");
            var link = document.querySelector('.nav-links a[href="#' + id + '"]');
            if (link) {
                if (scrollY >= top && scrollY < top + height) {
                    link.style.color = "#fff";
                } else {
                    link.style.color = "";
                }
            }
        });
    });
    // Fetch live diesel price and auto-calculate ALL linked numbers
    fetch("data/diesel-price.json?" + Date.now())
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data.price) return;

            var price = data.price;
            var EVOX_ANNUAL = 14076;   // EVOX fixed annual cost
            var INVEST = 70000;        // Approximate system investment
            var DAILY_LITRES = 65;     // Daily diesel consumption
            var DAYS_PER_MONTH = 26;

            // ── Calculate all numbers from diesel price ──
            var dailyCost = price * DAILY_LITRES;
            var monthlyCost = dailyCost * DAYS_PER_MONTH;
            var annualDiesel = monthlyCost * 12;
            var annualSavings = annualDiesel - EVOX_ANNUAL;
            var savingsPct = Math.round((annualSavings / annualDiesel) * 100);
            var tenYearSavings = annualSavings * 10;
            var roiMultiple = (tenYearSavings / INVEST).toFixed(1);
            var paybackMonths = Math.round(INVEST / (annualSavings / 12));

            function fmt(n) { return n.toLocaleString("en-SG", {maximumFractionDigits:0}); }

            // ── 1. Diesel price stat card ──
            var el = document.querySelector('.stat-number[data-target]');
            if (el) el.setAttribute("data-target", price.toFixed(2));

            var titleEl = el && el.parentElement.querySelector(".stat-title");
            if (titleEl && data.date) titleEl.textContent = "Diesel Price (" + data.date + ")";

            var descEl = el && el.parentElement.querySelector(".stat-desc");
            if (descEl && data.updated_at) {
                var updated = new Date(data.updated_at);
                var updatedStr = updated.toLocaleDateString("en-SG", {day:"numeric", month:"short", year:"numeric"});
                var next = new Date(updated);
                next.setDate(next.getDate() + 1);
                next.setHours(10, 0, 0, 0);
                var nextStr = next.toLocaleDateString("en-SG", {day:"numeric", month:"short", year:"numeric"}) + " 10:00 AM SGT";
                descEl.innerHTML = "S$" + price.toFixed(2) + "/L at Singapore pump stations." +
                    "<br><small style='color:#666;'>Source: " + (data.source || "petrolprice.sg") +
                    " &bull; Updated: " + updatedStr +
                    " &bull; Next auto-check: " + nextStr + "</small>";
            }

            // ── 2. Hero section ──
            var heroP = document.getElementById("hero-saving-pct");
            if (heroP) heroP.textContent = savingsPct + "%";
            var heroSub = document.getElementById("hero-subtitle-pct");
            if (heroSub) heroSub.textContent = savingsPct;

            // ── 3. Pillar "XX% Lower Cost" ──
            var pillar = document.getElementById("pillar-cost-pct");
            if (pillar) pillar.textContent = savingsPct + "% Lower Cost";

            // ── 4. Cost comparison - diesel side ──
            var dieselAnn = document.getElementById("diesel-annual");
            if (dieselAnn) dieselAnn.innerHTML = "S$" + fmt(annualDiesel) + "<span>/yr</span>";
            var dieselDay = document.getElementById("diesel-daily");
            if (dieselDay) dieselDay.textContent = "Fuel: " + DAILY_LITRES + "L/day × S$" + price.toFixed(2) + " = S$" + fmt(dailyCost) + "/day";
            var dieselMon = document.getElementById("diesel-monthly");
            if (dieselMon) dieselMon.textContent = "Monthly fuel: ~S$" + fmt(monthlyCost);

            // ── 5. Savings VS section ──
            var savAmt = document.getElementById("annual-savings");
            if (savAmt) savAmt.textContent = "S$" + fmt(annualSavings);
            var savPct = document.getElementById("savings-pct");
            if (savPct) savPct.textContent = savingsPct + "% reduction";

            // ── 6. ROI banner ──
            var roiPay = document.getElementById("roi-payback");
            if (roiPay) roiPay.textContent = paybackMonths + " months";
            var roi10 = document.getElementById("roi-10yr");
            if (roi10) roi10.textContent = "S$" + fmt(tenYearSavings);
            var roiX = document.getElementById("roi-multiple");
            if (roiX) roiX.textContent = roiMultiple + "x";

        })
        .catch(function() { /* use fallback hardcoded values */ });

})();
