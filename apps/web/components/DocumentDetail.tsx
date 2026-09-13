'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, type DemoUser, type DocumentItem } from '@/lib/api';
import { StatusBadge } from './StatusBadge';
import { UserSelector } from './UserSelector';

type Props = {
  documentId: string;
  initialUser: DemoUser;
};

export function DocumentDetail({ documentId, initialUser }: Props) {
  const [user, setUser] = useState<DemoUser>(initialUser);
  const [item, setItem] = useState<DocumentItem>();
  const [error, setError] = useState('');
  const [isRetrying, setIsRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      setError('');
      const response = await api.getDocument(documentId, user);
      setItem(response.item);
      setError('');
    } catch (requestError) {
      setItem(undefined);
          setError(requestError instanceof Error ? requestError.message : 'Unable to load document');
    }
  }, [documentId, user]);

  useEffect(() => {
    let cancelled = false;
    api.getDocument(documentId, user)
      .then((response) => {
        if (!cancelled) setItem(response.item);
      setError('');
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setItem(undefined);
          setError(requestError instanceof Error ? requestError.message : 'Unable to load document');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, user]);

  async function retry() {
    try {
      setIsRetrying(true);
      const response = await api.retryDocument(documentId, user);
      setItem(response.item);
      setError('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to retry');
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <section className="pageShell">
      <div className="pageHeading">
        <div>
          <Link href="/">← All documents</Link>
          <h1>{item?.fileName ?? 'Document detail'}</h1>
        </div>
        <UserSelector value={user} onChange={setUser} />
      </div>

      {error && <p className="errorBanner">{error}</p>}

      {item && (
        <div className="detailCard">
          <div className="detailHeader">
            <div>
              <span className="label">Status</span>
              <StatusBadge status={item.status} />
            </div>
            <div>
              <span className="label">Attempt</span>
              <strong>{item.attempt}</strong>
            </div>
            <div className="buttonGroup">
              <button type="button" className="secondaryButton" onClick={load}>Refresh</button>
              <button type="button" onClick={retry} disabled={isRetrying}>
                {isRetrying ? 'Retrying...' : 'Retry processing'}
              </button>
            </div>
          </div>

          <h2>Extraction result</h2>
          {item.result ? (
            <dl className="resultGrid">
              <div><dt>Invoice</dt><dd>{item.result.invoiceNumber ?? '—'}</dd></div>
              <div><dt>Supplier</dt><dd>{item.result.supplier ?? '—'}</dd></div>
              <div><dt>Total</dt><dd>{item.result.currency} {item.result.total}</dd></div>
              <div><dt>Date</dt><dd>{item.result.date ?? '—'}</dd></div>
              <div className="wide"><dt>Summary</dt><dd>{item.result.summary ?? '—'}</dd></div>
            </dl>
          ) : (
            <p className="emptyState">No extraction result is available yet.</p>
          )}
        </div>
      )}
    </section>
  );
}
