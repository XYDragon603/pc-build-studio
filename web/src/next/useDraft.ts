import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { fromApi, toApiInput } from '../api/mapping';
import { loadDraft, saveDraft } from '../domain/storage';
import type { Build } from '../domain/types';

export function useDraft(editing: boolean, build: Build) {
  const [draft, setDraft] = useState(loadDraft);
  const [draftStatus, setDraftStatus] = useState('');
  const lastEdit = useRef<Build | null>(null);
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    api.loadDraft().then(saved => {
      if (!saved || !active || lastEdit.current) return;
      const restored = fromApi(saved.build);
      setDraft({ ...restored, id: saved.serverId ?? restored.id, serverId: saved.serverId, version: saved.version });
    }).catch(() => { if (active && !lastEdit.current) setDraftStatus('草稿读取失败'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!editing || lastEdit.current === build) return;
    lastEdit.current = build;
    saveDraft(build);
    setDraft(build);
    setDraftStatus('正在保存草稿…');
    queue.current = queue.current.then(async () => {
      if (lastEdit.current !== build) return;
      try {
        await api.saveDraft({ build: toApiInput(build), serverId: build.serverId, version: build.version });
        if (lastEdit.current === build) setDraftStatus('草稿已保存在本机');
      } catch {
        if (lastEdit.current === build) setDraftStatus('草稿同步失败，请手动保存方案');
      }
    });
  }, [editing, build]);

  return { draft, draftStatus };
}
