import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageLayoutType } from '@grafana/data';
import { getBackendSrv, PluginPage } from '@grafana/runtime';
import { Dashboard } from '@grafana/schema';
import { EmbeddedScene, UrlSyncContextProvider } from '@grafana/scenes';
import { Alert, LoadingPlaceholder } from '@grafana/ui';

import { toScene, Unsupported } from '../scene/convert';

type Loaded = { title: string; scene: EmbeddedScene } | { title: string; error: Unsupported } | { crash: unknown };

export function DockPage() {
  const { uid } = useParams();
  const [loaded, setLoaded] = useState<Loaded>();
  useEffect(() => {
    getBackendSrv()
      .get<{ dashboard: Dashboard & { uid: string } }>(`/api/dashboards/uid/${uid}`)
      .then(({ dashboard }) => {
        const title = dashboard.title ?? uid!;
        try {
          setLoaded({ title, scene: toScene(dashboard) });
        } catch (error) {
          setLoaded(error instanceof Unsupported ? { title, error } : { crash: error });
        }
      }, (crash) => setLoaded({ crash }));
  }, [uid]);

  if (loaded && 'crash' in loaded) {
    throw loaded.crash; // to Grafana's error boundary
  }
  return (
    <PluginPage pageNav={{ text: loaded?.title ?? uid! }} layout={PageLayoutType.Custom}>
      {!loaded ? (
        <LoadingPlaceholder text="Loading dashboard…" />
      ) : 'error' in loaded ? (
        <Alert severity="error" title="This dashboard does not open in the dock">
          {loaded.error.message} <a href={`/d/${uid}`}>Open it natively.</a>
        </Alert>
      ) : (
        <UrlSyncContextProvider scene={loaded.scene} updateUrlOnInit createBrowserHistorySteps>
          <loaded.scene.Component model={loaded.scene} />
        </UrlSyncContextProvider>
      )}
    </PluginPage>
  );
}
