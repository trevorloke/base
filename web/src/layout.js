// Two facts about the page's layout, said with a class instead of :has():
//   #root.has-nav     the signed-in shell is up — room for the sidebar
//   .page.page--map   the map's screen — the one full-width one
// A browser without :has() (Firefox before 121, Safari before 15.4, Chrome
// before 105) dropped the :has() rules that once said this: the sidebar lay
// over the page, and the map lost its width. layout.css says it by class.
import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';
import './layout.css';

// The class for the shell's <main>; while it is mounted, #root has the nav.
export function usePageClass() {
  useLayoutEffect(() => {
    const root = document.getElementById('root');
    root?.classList.add('has-nav');
    return () => root?.classList.remove('has-nav');
  }, []);
  return useLocation().pathname === '/map' ? 'page page--map' : 'page';
}
