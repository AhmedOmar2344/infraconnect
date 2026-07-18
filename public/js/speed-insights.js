/**
 * Vercel Speed Insights Initialization
 * 
 * This script initializes Vercel Speed Insights for tracking web vitals
 * and performance metrics across all pages of the InfraConnect website.
 * 
 * The script will automatically load when deployed on Vercel and will
 * use the production Speed Insights service.
 */

(function() {
  'use strict';
  
  // Only load in production on Vercel
  // Speed Insights is automatically enabled when the app is deployed to Vercel
  if (typeof window === 'undefined') return;
  
  // Initialize the queue if not already present
  if (!window.si) {
    window.si = function(...params) {
      window.siq = window.siq || [];
      window.siq.push(params);
    };
  }
  
  // Create and inject the Speed Insights script
  var script = document.createElement('script');
  script.defer = true;
  
  // When deployed on Vercel, this path is automatically available
  // For local development, this will gracefully fail without errors
  script.src = '/_vercel/speed-insights/script.js';
  
  script.onerror = function() {
    // Silently fail if Speed Insights is not available (e.g., local development)
    // This ensures the site continues to work normally
    console.debug('Speed Insights not available - this is expected in local development');
  };
  
  // Inject the script into the page
  var firstScript = document.getElementsByTagName('script')[0];
  if (firstScript && firstScript.parentNode) {
    firstScript.parentNode.insertBefore(script, firstScript);
  } else {
    document.head.appendChild(script);
  }
})();
