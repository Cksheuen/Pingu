import "./styles.css";

const host = document.querySelector<HTMLElement>("#current-host");
const year = document.querySelector<HTMLElement>("#current-year");

if (host && window.location.hostname) {
  host.textContent = window.location.hostname;
}

if (year) {
  year.textContent = String(new Date().getFullYear());
}
