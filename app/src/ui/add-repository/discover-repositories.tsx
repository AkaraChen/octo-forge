import * as React from 'react'
import * as Path from 'path'
import untildify from 'untildify'

import { Dispatcher } from '../dispatcher'
import { Button } from '../lib/button'
import { TextBox } from '../lib/text-box'
import { Row } from '../lib/row'
import { Checkbox, CheckboxValue } from '../lib/checkbox'
import { LinkButton } from '../lib/link-button'
import { Dialog, DialogContent, DialogFooter } from '../dialog'
import { OkCancelButtonGroup } from '../dialog/ok-cancel-button-group'
import { FoldoutType } from '../../lib/app-state'
import { showOpenDialog } from '../main-process-proxy'
import {
  scanDirectoryForRepositories,
  IDiscoveredRepository,
} from '../../lib/scan-for-repositories'
import { FilterList, IFilterListItem } from '../lib/filter-list'
import { IMatches } from '../../lib/fuzzy-find'
import { Octicon, syncClockwise } from '../octicons'
import * as octicons from '../octicons/octicons.generated'
import { HighlightText } from '../lib/highlight-text'
import { TooltippedContent } from '../lib/tooltipped-content'
import { ClickSource } from '../lib/list'

interface IDiscoverRepositoriesProps {
  readonly dispatcher: Dispatcher
  readonly onDismissed: () => void
  readonly initialPath?: string
}

interface IDiscoveredRepoListItem extends IFilterListItem {
  readonly id: string
  readonly text: ReadonlyArray<string>
  readonly path: string
  readonly mtimeMs: number
}

type DialogStep =
  | { kind: 'idle' }
  | { kind: 'scanning'; rootPath: string }
  | {
      kind: 'results'
      rootPath: string
      repositories: ReadonlyArray<IDiscoveredRepository>
    }

interface IDiscoverRepositoriesState {
  readonly path: string
  readonly step: DialogStep
  readonly selected: ReadonlySet<string>
  readonly filterText: string
  readonly scanError: string | null
}

const RowHeight = 32

export class DiscoverRepositories extends React.Component<
  IDiscoverRepositoriesProps,
  IDiscoverRepositoriesState
> {
  private abortController: AbortController | null = null

  public constructor(props: IDiscoverRepositoriesProps) {
    super(props)

    this.state = {
      path: props.initialPath ?? '',
      step: { kind: 'idle' },
      selected: new Set(),
      filterText: '',
      scanError: null,
    }
  }

  public componentWillUnmount() {
    this.abortController?.abort()
  }

  private resolvedPath(path: string): string {
    return Path.resolve('/', untildify(path))
  }

  private onPathChanged = (path: string) => {
    this.setState({ path })
  }

  private showFilePicker = async () => {
    const path = await showOpenDialog({ properties: ['openDirectory'] })
    if (path === null) {
      return
    }
    this.setState({ path })
  }

  private displayPath(rootPath: string, repoPath: string): string {
    const rel = Path.relative(rootPath, repoPath)
    if (rel === '' || rel.startsWith('..')) {
      return repoPath
    }
    return rel
  }

  private startScan = async (rootPath: string) => {
    this.abortController?.abort()

    const controller = new AbortController()
    this.abortController = controller

    this.setState({
      step: { kind: 'scanning', rootPath },
      selected: new Set(),
      filterText: '',
      scanError: null,
    })

    try {
      const repositories = await scanDirectoryForRepositories(rootPath, {
        signal: controller.signal,
      })

      if (controller.signal.aborted) {
        return
      }

      this.setState({ step: { kind: 'results', rootPath, repositories } })
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.setState({ step: { kind: 'idle' } })
        return
      }
      this.setState({
        step: { kind: 'idle' },
        scanError: err?.message ?? 'Failed to scan the selected folder.',
      })
    } finally {
      if (this.abortController === controller) {
        this.abortController = null
      }
    }
  }

  private onScanFromIdle = () => {
    const { path } = this.state
    if (path.length === 0) {
      return
    }
    void this.startScan(this.resolvedPath(path))
  }

  private onRescan = () => {
    const { step } = this.state
    if (step.kind === 'results') {
      void this.startScan(step.rootPath)
    }
  }

  private onCancelScan = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    this.abortController?.abort()
  }

  private onBackToIdle = () => {
    this.setState({
      step: { kind: 'idle' },
      selected: new Set(),
      filterText: '',
      scanError: null,
    })
  }

  private toggle(repoPath: string) {
    const next = new Set(this.state.selected)
    if (next.has(repoPath)) {
      next.delete(repoPath)
    } else {
      next.add(repoPath)
    }
    this.setState({ selected: next })
  }

  private onItemClickFromList = (
    item: IDiscoveredRepoListItem,
    _source: ClickSource
  ) => {
    this.toggle(item.path)
  }

  private onCheckboxChange = (event: React.FormEvent<HTMLInputElement>) => {
    const row = event.currentTarget.closest('.discover-repositories-row')
    const path = row instanceof HTMLElement ? row.dataset.path : undefined

    if (path !== undefined) {
      this.toggle(path)
    }
  }

  private onFilterTextChanged = (text: string) => {
    this.setState({ filterText: text })
  }

  private onSubmit = async () => {
    const { step, selected } = this.state

    if (step.kind === 'idle') {
      this.onScanFromIdle()
      return
    }

    if (step.kind !== 'results' || selected.size === 0) {
      return
    }

    const paths = [...selected]
    this.props.onDismissed()

    const { dispatcher } = this.props
    const added = await dispatcher.addRepositories(paths)

    if (added.length > 0) {
      dispatcher.closeFoldout(FoldoutType.Repository)
      dispatcher.selectRepository(added[0])
      dispatcher.recordAddExistingRepository()
    }
  }

  private buildItems(
    rootPath: string,
    repositories: ReadonlyArray<IDiscoveredRepository>
  ): ReadonlyArray<IDiscoveredRepoListItem> {
    return repositories.map(r => ({
      id: r.path,
      text: [this.displayPath(rootPath, r.path)],
      path: r.path,
      mtimeMs: r.mtimeMs,
    }))
  }

  private renderRow = (item: IDiscoveredRepoListItem, matches: IMatches) => {
    const checked = this.state.selected.has(item.path)
    return (
      <div className="discover-repositories-row" data-path={item.path}>
        <Checkbox
          value={checked ? CheckboxValue.On : CheckboxValue.Off}
          onChange={this.onCheckboxChange}
        />
        <Octicon className="icon" symbol={octicons.repo} />
        <TooltippedContent
          className="name"
          tooltip={item.path}
          onlyWhenOverflowed={true}
          tagName="div"
        >
          <HighlightText text={item.text[0]} highlight={matches.title} />
        </TooltippedContent>
      </div>
    )
  }

  private renderRescanButton = () => {
    const tooltip = 'Re-scan'
    return (
      <Button onClick={this.onRescan} ariaLabel={tooltip} tooltip={tooltip}>
        <Octicon symbol={syncClockwise} />
      </Button>
    )
  }

  private renderNoResultMatches = () => (
    <div className="no-items no-results-found">
      <div>No repositories match your filter.</div>
    </div>
  )

  private renderIdle() {
    return (
      <DialogContent>
        <Row>
          <TextBox
            value={this.state.path}
            label={__DARWIN__ ? 'Local Path' : 'Local path'}
            placeholder="folder to scan"
            onValueChanged={this.onPathChanged}
          />
          <Button onClick={this.showFilePicker}>Choose…</Button>
        </Row>
        <Row>
          <p className="discover-repositories-description">
            Pick a folder and we'll look for all the Git repositories inside it
            (up to 6 levels deep). You'll then choose which ones to add.
          </p>
        </Row>
        {this.state.scanError && (
          <Row>
            <p className="discover-repositories-error" role="alert">
              {this.state.scanError}
            </p>
          </Row>
        )}
      </DialogContent>
    )
  }

  private renderScanning(rootPath: string) {
    return (
      <DialogContent>
        <Row>
          <p>Scanning {rootPath}…</p>
        </Row>
      </DialogContent>
    )
  }

  private renderResults(
    rootPath: string,
    repositories: ReadonlyArray<IDiscoveredRepository>
  ) {
    if (repositories.length === 0) {
      return (
        <DialogContent>
          <Row>
            <p>No Git repositories were found under this folder.</p>
          </Row>
          <Row>
            <LinkButton onClick={this.onBackToIdle}>
              Scan a different folder
            </LinkButton>
          </Row>
        </DialogContent>
      )
    }

    const items = this.buildItems(rootPath, repositories)

    return (
      <DialogContent className="discover-repositories-content">
        <Row>
          <FilterList<IDiscoveredRepoListItem>
            className="discover-repositories"
            rowHeight={RowHeight}
            groups={[{ identifier: 'all', items }]}
            selectedItem={null}
            renderItem={this.renderRow}
            filterText={this.state.filterText}
            onFilterTextChanged={this.onFilterTextChanged}
            placeholderText="Filter repositories"
            invalidationProps={{ items, selected: this.state.selected }}
            renderPostFilter={this.renderRescanButton}
            onItemClick={this.onItemClickFromList}
            renderNoItems={this.renderNoResultMatches}
          />
        </Row>
      </DialogContent>
    )
  }

  private renderBody() {
    switch (this.state.step.kind) {
      case 'idle':
        return this.renderIdle()
      case 'scanning':
        return this.renderScanning(this.state.step.rootPath)
      case 'results':
        return this.renderResults(
          this.state.step.rootPath,
          this.state.step.repositories
        )
    }
  }

  private renderFooter() {
    const { step, selected } = this.state

    if (step.kind === 'scanning') {
      return (
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText="Cancel"
            cancelButtonVisible={false}
            onOkButtonClick={this.onCancelScan}
          />
        </DialogFooter>
      )
    }

    if (step.kind === 'results') {
      const count = selected.size
      const okText =
        count > 0
          ? __DARWIN__
            ? `Add ${count} Repositor${count === 1 ? 'y' : 'ies'}`
            : `Add ${count} repositor${count === 1 ? 'y' : 'ies'}`
          : __DARWIN__
          ? 'Add Repositories'
          : 'Add repositories'

      return (
        <DialogFooter>
          <OkCancelButtonGroup
            okButtonText={okText}
            okButtonDisabled={count === 0}
            cancelButtonText={__DARWIN__ ? 'Back' : 'Back'}
            onCancelButtonClick={this.onBackToIdleFromFooter}
          />
        </DialogFooter>
      )
    }

    return (
      <DialogFooter>
        <OkCancelButtonGroup
          okButtonText="Scan"
          okButtonDisabled={this.state.path.length === 0}
        />
      </DialogFooter>
    )
  }

  private onBackToIdleFromFooter = (
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    event.preventDefault()
    this.onBackToIdle()
  }

  public render() {
    return (
      <Dialog
        id="discover-repositories"
        title={
          __DARWIN__
            ? 'Discover Local Repositories'
            : 'Discover local repositories'
        }
        onSubmit={this.onSubmit}
        onDismissed={this.props.onDismissed}
        loading={this.state.step.kind === 'scanning'}
      >
        {this.renderBody()}
        {this.renderFooter()}
      </Dialog>
    )
  }
}
