package web

import "html/template"

// themeInitJS runs in <head> before first paint on every admin page
// (templates via {{template "head"}}, login/setup via authHead). It
// resolves the operator's theme choice (localStorage "sieve-theme":
// "light" | "dark" | "system"; dark when nothing is saved) and sets class="dark" on
// <html> synchronously, so there is no light/dark flash on load. With
// "system" it follows prefers-color-scheme live; inside the desktop app
// Electron's nativeTheme drives that media query.
//
// window.sieveSetTheme(choice) is the sidebar toggle's entry point; it
// persists the choice and updates any [data-theme-choice] buttons'
// aria-pressed state. Storage failures (private mode, blocked storage)
// degrade to the dark default for this page view.
const themeInitJS = `(function(){
  var KEY = 'sieve-theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function read(){ try { return localStorage.getItem(KEY) || 'dark'; } catch (e) { return 'dark'; } }
  var choice = read();
  function apply(){
    var dark = choice === 'dark' || (choice !== 'light' && !!(mq && mq.matches));
    root.classList.toggle('dark', dark);
    root.setAttribute('data-theme', choice);
    var btns = document.querySelectorAll('[data-theme-choice]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-theme-choice') === choice ? 'true' : 'false');
    }
  }
  window.sieveSetTheme = function(c){
    choice = (c === 'light' || c === 'dark') ? c : 'system';
    try { localStorage.setItem(KEY, choice); } catch (e) {}
    apply();
  };
  if (mq) {
    var onChange = function(){ if (choice === 'system') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  apply();
  document.addEventListener('DOMContentLoaded', apply);
})();`

// themeInitScript exposes themeInitJS to templates as trusted JS.
func themeInitScript() template.JS { return template.JS(themeInitJS) } // xss-safe: themeInitJS is a compile-time constant with no dynamic input
