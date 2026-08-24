import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Button from '@cloudscape-design/components/button';
import FileUpload from '@cloudscape-design/components/file-upload';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import Pagination from '@cloudscape-design/components/pagination';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import TextFilter from '@cloudscape-design/components/text-filter';
import { describeError } from '../../api/client';
import type { ServiceCatalog } from '../../catalog/types';
import type { EndpointConfig } from '../../endpoints/store';
import { DestructiveConfirm } from '../../generic/DestructiveConfirm';
import { fileToBase64 } from '../../generic/files';
import { formatBytes, formatDateTime } from '../format';
import { fileNameFor, saveBlob, toBlob } from './download';
import { ObjectDetails } from './ObjectDetails';
import {
  deleteObject,
  displayName,
  getObject,
  headObject,
  listObjects,
  prefixCrumbs,
  putObject,
  type Listing,
  type ObjectMetadata,
  type ObjectSummary,
} from './objects';

/**
 * The prefix browser for one bucket.
 *
 * S3 has no folders — the delimiter is what makes a flat key space browsable,
 * so a "folder" row here is a `CommonPrefix` the service returned and clicking
 * it re-lists at that prefix rather than filtering in the browser.
 */

interface Row {
  id: string;
  kind: 'prefix' | 'object';
  name: string;
  key: string;
  size?: number;
  lastModified?: string;
  storageClass?: string;
}

function rowsFor(listing: Listing | undefined, prefix: string): Row[] {
  if (!listing) return [];
  const prefixRows = listing.prefixes.map<Row>(entry => ({
    id: `prefix:${entry}`,
    kind: 'prefix',
    name: displayName(entry, prefix),
    key: entry,
  }));
  const objectRows = listing.objects
    // The prefix itself comes back as a zero-byte key on targets that create
    // folder markers; showing it as a row inside itself would be a dead end.
    .filter(object => object.key !== prefix)
    .map<Row>((object: ObjectSummary) => ({
      id: `object:${object.key}`,
      kind: 'object',
      name: displayName(object.key, prefix),
      key: object.key,
      size: object.size,
      lastModified: object.lastModified,
      storageClass: object.storageClass,
    }));
  return [...prefixRows, ...objectRows];
}

export function ObjectBrowser({
  endpoint,
  catalog,
  bucket,
  initialPrefix = '',
  onExit,
}: {
  endpoint: EndpointConfig;
  catalog: ServiceCatalog;
  bucket: string;
  /** Where to open, when another screen asked for a particular prefix. */
  initialPrefix?: string;
  onExit(): void;
}) {
  const [prefix, setPrefix] = useState(initialPrefix);
  const [notice, setNotice] = useState<string>();
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Row[]>([]);
  const [metadata, setMetadata] = useState<{ key: string; value?: ObjectMetadata }>();
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Row>();
  const [busy, setBusy] = useState(false);
  /** Failures from an action rather than from the listing itself. */
  const [actionError, setActionError] = useState<{ header: string; detail: string }>();

  const inFlight = useRef<AbortController>(undefined);
  useEffect(() => () => inFlight.current?.abort(), []);

  const listingKey = `${endpoint.url}|${bucket}|${prefix}|${reload}`;

  // The listing is derived from its own request key, the way the schema tree
  // and the bucket list are: navigating to a prefix or reloading shows the
  // spinner again without the effect having to reset state first.
  const [listed, setListed] = useState<{
    key: string;
    pages: Listing[];
    index: number;
    error?: { header: string; detail: string };
  }>();
  const [fetchingNext, setFetchingNext] = useState(false);
  const current = listed?.key === listingKey ? listed : undefined;
  const pages = current?.pages ?? [];
  const pageIndex = current?.index ?? 0;
  const loading = !current || fetchingNext;

  useEffect(() => {
    const controller = new AbortController();
    listObjects(endpoint, catalog, { bucket, prefix }, controller.signal).then(
      listing =>
        !controller.signal.aborted && setListed({ key: listingKey, pages: [listing], index: 0 }),
      caught =>
        !controller.signal.aborted &&
        setListed({ key: listingKey, pages: [], index: 0, error: describeError(caught) }),
    );
    return () => controller.abort();
  }, [endpoint, catalog, bucket, listingKey, prefix]);

  // Selection and the metadata panel belong to a prefix; keeping them across a
  // navigation would describe an object that is no longer on screen.
  const [scopedTo, setScopedTo] = useState(listingKey);
  if (scopedTo !== listingKey) {
    setScopedTo(listingKey);
    setSelected([]);
    setMetadata(undefined);
    setActionError(undefined);
  }

  const selectObject = useCallback(
    (row: Row | undefined) => {
      setSelected(row ? [row] : []);
      if (!row || row.kind !== 'object') {
        setMetadata(undefined);
        return;
      }
      const controller = new AbortController();
      inFlight.current?.abort();
      inFlight.current = controller;
      setMetadata({ key: row.key });
      setMetadataLoading(true);
      headObject(endpoint, catalog, bucket, row.key, controller.signal).then(
        value => {
          if (controller.signal.aborted) return;
          setMetadata({ key: row.key, value });
          setMetadataLoading(false);
        },
        caught => {
          if (controller.signal.aborted) return;
          setActionError(describeError(caught));
          setMetadataLoading(false);
        },
      );
    },
    [endpoint, catalog, bucket],
  );

  function showPage(index: number) {
    setListed(state => (state?.key === listingKey ? { ...state, index } : state));
  }

  async function fetchNext(token: string) {
    setFetchingNext(true);
    try {
      const listing = await listObjects(endpoint, catalog, { bucket, prefix, token });
      setListed(state =>
        state?.key === listingKey
          ? { ...state, pages: [...state.pages, listing], index: state.pages.length }
          : state,
      );
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setFetchingNext(false);
    }
  }

  async function download(row: Row) {
    setBusy(true);
    setActionError(undefined);
    try {
      const object = await getObject(endpoint, catalog, bucket, row.key);
      const saved = saveBlob(
        toBlob(object.body, object.encoding, object.contentType),
        fileNameFor(row.key),
      );
      setNotice(
        saved
          ? `Downloaded ${row.key}.`
          : `Fetched ${row.key}, but this browser offers no way to save it.`,
      );
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removeObject(row: Row) {
    setBusy(true);
    setActionError(undefined);
    try {
      await deleteObject(endpoint, catalog, bucket, row.key);
      setNotice(`Deleted ${row.key}.`);
      setConfirmDelete(undefined);
      setReload(count => count + 1);
    } catch (caught) {
      setActionError(describeError(caught));
      setConfirmDelete(undefined);
    } finally {
      setBusy(false);
    }
  }

  const page = pages[pageIndex];
  const needle = filter.trim().toLowerCase();
  const rows = rowsFor(page, prefix).filter(
    row => !needle || row.name.toLowerCase().includes(needle),
  );
  const selectedObject = selected[0]?.kind === 'object' ? selected[0] : undefined;
  const deleteOperation = catalog.operations.DeleteObject;

  return (
    <SpaceBetween size="l">
      <BreadcrumbGroup
        data-testid="prefix-crumbs"
        ariaLabel="Prefix"
        items={[
          { text: 'Buckets', href: '#buckets' },
          ...prefixCrumbs(bucket, prefix).map(crumb => ({
            text: crumb.label,
            href: `#${crumb.prefix}`,
          })),
        ]}
        onFollow={event => {
          event.preventDefault();
          const href = event.detail.href.slice(1);
          if (href === 'buckets') onExit();
          else setPrefix(href === bucket ? '' : href);
        }}
      />

      {current?.error && (
        <Alert type="error" header={current.error.header} data-testid="s3-error">
          {current.error.detail}
        </Alert>
      )}

      {actionError && (
        <Alert
          type="error"
          header={actionError.header}
          data-testid="s3-action-error"
          dismissible
          onDismiss={() => setActionError(undefined)}
        >
          {actionError.detail}
        </Alert>
      )}

      {notice && (
        <Alert
          type="success"
          dismissible
          data-testid="s3-notice"
          onDismiss={() => setNotice(undefined)}
        >
          {notice}
        </Alert>
      )}

      <Table
        data-testid="object-table"
        variant="container"
        loading={loading && pages.length === 0}
        loadingText="Listing objects"
        selectionType="single"
        selectedItems={selected}
        trackBy="id"
        ariaLabels={{
          selectionGroupLabel: 'Object selection',
          itemSelectionLabel: (_state, row: Row) => `Select ${row.name}`,
        }}
        onSelectionChange={event => selectObject(event.detail.selectedItems[0])}
        columnDefinitions={[
          {
            id: 'name',
            header: 'Name',
            cell: (row: Row) =>
              row.kind === 'prefix' ? (
                <Link
                  href={`#${row.key}`}
                  data-testid={`open-prefix-${row.name}`}
                  onFollow={event => {
                    event.preventDefault();
                    setPrefix(row.key);
                  }}
                >
                  {row.name}
                </Link>
              ) : (
                <span data-testid={`object-${row.name}`}>{row.name}</span>
              ),
          },
          {
            id: 'type',
            header: 'Type',
            cell: (row: Row) => (row.kind === 'prefix' ? 'Prefix' : 'Object'),
          },
          {
            id: 'size',
            header: 'Size',
            cell: (row: Row) => (row.kind === 'prefix' ? '—' : formatBytes(row.size)),
          },
          {
            id: 'lastModified',
            header: 'Last modified',
            cell: (row: Row) => (row.kind === 'prefix' ? '—' : formatDateTime(row.lastModified)),
          },
          {
            id: 'storageClass',
            header: 'Storage class',
            cell: (row: Row) => (row.kind === 'prefix' ? '—' : (row.storageClass ?? 'STANDARD')),
          },
        ]}
        items={rows}
        empty={
          <Box textAlign="center" color="text-body-secondary" padding="m">
            {needle ? 'Nothing under this prefix matches that filter.' : 'This prefix is empty.'}
          </Box>
        }
        filter={
          <TextFilter
            filteringText={filter}
            filteringPlaceholder="Find by name"
            filteringAriaLabel="Find by name"
            onChange={event => setFilter(event.detail.filteringText)}
          />
        }
        header={
          <Header
            variant="h2"
            counter={`(${rows.length})`}
            description={`s3://${bucket}/${prefix}`}
            actions={
              <SpaceBetween size="xs" direction="horizontal">
                <Button
                  iconName="refresh"
                  ariaLabel="Reload this prefix"
                  loading={loading}
                  onClick={() => setReload(count => count + 1)}
                />
                <Button
                  disabled={!selectedObject || busy}
                  data-testid="download-object"
                  onClick={() => selectedObject && void download(selectedObject)}
                >
                  Download
                </Button>
                <Button
                  disabled={!selectedObject || busy || !deleteOperation}
                  data-testid="delete-object"
                  onClick={() => setConfirmDelete(selectedObject)}
                >
                  Delete
                </Button>
                <Button
                  variant="primary"
                  data-testid="upload-object"
                  onClick={() => setUploadOpen(true)}
                >
                  Upload
                </Button>
              </SpaceBetween>
            }
          >
            Objects
          </Header>
        }
        pagination={
          <Pagination
            currentPageIndex={pageIndex + 1}
            pagesCount={Math.max(pages.length, 1)}
            openEnd={Boolean(page?.nextToken)}
            disabled={loading}
            ariaLabels={{
              nextPageLabel: 'Next page',
              previousPageLabel: 'Previous page',
              pageLabel: pageNumber => `Page ${pageNumber}`,
            }}
            onChange={event => {
              const requested = event.detail.currentPageIndex - 1;
              if (requested < pages.length) showPage(requested);
            }}
            onNextPageClick={() => {
              if (pageIndex === pages.length - 1 && page?.nextToken) void fetchNext(page.nextToken);
              else if (pageIndex < pages.length - 1) showPage(pageIndex + 1);
            }}
            onPreviousPageClick={() => showPage(Math.max(0, pageIndex - 1))}
          />
        }
      />

      {metadata && (
        <ObjectDetails
          objectKey={metadata.key}
          metadata={metadata.value}
          loading={metadataLoading}
        />
      )}

      {uploadOpen && (
        <UploadModal
          bucket={bucket}
          prefix={prefix}
          onDismiss={() => setUploadOpen(false)}
          onUpload={async request => {
            await putObject(endpoint, catalog, { bucket, ...request });
            setUploadOpen(false);
            setNotice(`Uploaded ${request.key}.`);
            setReload(count => count + 1);
          }}
        />
      )}

      {confirmDelete && deleteOperation && (
        <DestructiveConfirm
          operation={deleteOperation}
          identifier={{ field: 'Key', value: confirmDelete.key }}
          onDismiss={() => setConfirmDelete(undefined)}
          onConfirm={() => void removeObject(confirmDelete)}
        />
      )}
    </SpaceBetween>
  );
}

function UploadModal({
  bucket,
  prefix,
  onDismiss,
  onUpload,
}: {
  bucket: string;
  prefix: string;
  onDismiss(): void;
  onUpload(request: { key: string; body: string; contentType?: string }): Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [key, setKey] = useState('');
  const [touchedKey, setTouchedKey] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();

  const file = files[0];
  const effectiveKey = touchedKey ? key : file ? `${prefix}${file.name}` : '';

  async function submit() {
    if (!file || effectiveKey === '') return;
    setUploading(true);
    setError(undefined);
    try {
      await onUpload({
        key: effectiveKey,
        body: await fileToBase64(file),
        contentType: file.type || undefined,
      });
    } catch (caught) {
      setError(describeError(caught).detail);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal
      visible
      onDismiss={onDismiss}
      header="Upload an object"
      footer={
        <Box float="right">
          <SpaceBetween size="xs" direction="horizontal">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={uploading}
              disabled={!file || effectiveKey === ''}
              data-testid="confirm-upload"
              onClick={() => void submit()}
            >
              Upload
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form errorText={error}>
        <SpaceBetween size="m">
          <FormField
            label="File"
            description={`The file's bytes are sent as PutObject's body to s3://${bucket}/.`}
            stretch
          >
            <FileUpload
              value={files}
              onChange={event => setFiles(event.detail.value)}
              accept="*/*"
              showFileSize
              showFileLastModified
              i18nStrings={{
                uploadButtonText: () => 'Choose file',
                dropzoneText: () => 'Drop a file to upload',
                removeFileAriaLabel: index => `Remove file ${index + 1}`,
                limitShowFewer: 'Show fewer files',
                limitShowMore: 'Show more files',
                errorIconAriaLabel: 'Error',
              }}
            />
          </FormField>
          <FormField
            label="Key"
            description="Defaults to the current prefix plus the file's name."
            stretch
          >
            <Input
              value={effectiveKey}
              data-testid="upload-key"
              onChange={event => {
                setTouchedKey(true);
                setKey(event.detail.value);
              }}
            />
          </FormField>
        </SpaceBetween>
      </Form>
    </Modal>
  );
}
