import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppPlugin } from '@grafana/data';
import { initPluginTranslations } from '@grafana/i18n';
import { loadResources } from '@grafana/scenes';
import { Alert } from '@grafana/ui';

import { DockPage } from './pages/Dock';
import pluginJson from './plugin.json';

// the bundled Scenes and i18n copies translate through this plugin's own i18n instance
await initPluginTranslations(pluginJson.id, [loadResources]);

function App() {
  return (
    <Routes>
      <Route path="d/:uid" element={<DockPage />} />
      <Route path="*" element={<Alert title="Not a dock route">Open a dashboard as /a/evmain-tilers-app/d/&lt;uid&gt;</Alert>} />
    </Routes>
  );
}

export const plugin = new AppPlugin<{}>().setRootPage(App);
