// SPDX-License-Identifier: GPL-3.0-only
export function liveWindow(window){return !!window&&!window.isDestroyed();}
export function showWindow(window,{focus=false}={}){if(!liveWindow(window))return false;window.show();if(focus)window.focus();return true;}
export function preventBusyQuit(event,library,window){if(!(library?.busy||library?.preparation?.running))return false;event.preventDefault();showWindow(window);return true;}
