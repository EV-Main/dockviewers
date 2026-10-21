import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getBackendSrv } from '@grafana/runtime';
import { DashboardLink } from '@grafana/schema';
import { Button, Dropdown, LinkButton, Menu } from '@grafana/ui';

// The page URL mirrors the scene (url sync), so `var-*`, `from` and `to` are read straight off it.

/** The native dashboard, for what the dock does not do (editing, inspect). */
export function NativeLink({ uid }: { uid: string }) {
  const { search } = useLocation();
  return (
    <LinkButton href={`/d/${uid}${search}`} variant="secondary" fill="outline" icon="external-link-alt" tooltip="Open as a native dashboard">
      native
    </LinkButton>
  );
}

interface Hit {
  uid: string;
  title: string;
  url: string;
}

/** `dashboards`-type links: each a dropdown of the dashboards carrying its tags. */
export function DashboardLinks({ uid, links }: { uid: string; links: DashboardLink[] }) {
  return (
    <>
      {links.map((link, i) => (
        <TagLinks key={i} uid={uid} link={link} />
      ))}
    </>
  );
}

function TagLinks({ uid, link }: { uid: string; link: DashboardLink }) {
  const { search } = useLocation();
  const [hits, setHits] = useState<Hit[]>();
  useEffect(() => {
    getBackendSrv()
      .get<Hit[]>('/api/search', { tag: link.tags, type: 'dash-db', limit: 100 })
      .then((found) => setHits(found.filter((h) => h.uid !== uid)));
  }, [uid, link.tags]);

  const params = new URLSearchParams(search);
  const carried = new URLSearchParams(
    [...params].filter(([k]) => (link.keepTime && (k === 'from' || k === 'to')) || (link.includeVars && k.startsWith('var-')))
  ).toString();
  const menu = (
    <Menu>
      {(hits ?? []).map((h) => (
        <Menu.Item key={h.uid} label={h.title} url={carried ? `${h.url}?${carried}` : h.url} target={link.targetBlank ? '_blank' : undefined} />
      ))}
    </Menu>
  );
  return (
    <Dropdown overlay={menu}>
      <Button variant="secondary" fill="outline" icon="external-link-alt" disabled={!hits}>
        {link.title}
      </Button>
    </Dropdown>
  );
}
