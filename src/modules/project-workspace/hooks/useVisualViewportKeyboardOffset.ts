import { useEffect } from 'react';

/**
 * Keeps the fixed workspace shell above the virtual keyboard in iOS Safari.
 *
 * CloudCLI live: in a Safari tab (not the installed app) innerHeight shrinks
 * together with the visual viewport, so "innerHeight minus visual height" read
 * 0 and the shell kept its full height; the page then scrolled under it and
 * the composer was left half repainted. The keyboard is measured against the
 * layout height instead, and the page is kept scrolled to the top.
 */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return undefined;
    }

    const updateKeyboardHeight = () => {
      const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
      const keyboardHeight = Math.max(0, Math.round(layoutHeight - visualViewport.height));
      document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
      if (window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    updateKeyboardHeight();
    visualViewport.addEventListener('resize', updateKeyboardHeight);
    visualViewport.addEventListener('scroll', updateKeyboardHeight);
    return () => {
      visualViewport.removeEventListener('resize', updateKeyboardHeight);
      visualViewport.removeEventListener('scroll', updateKeyboardHeight);
    };
  }, []);
}
