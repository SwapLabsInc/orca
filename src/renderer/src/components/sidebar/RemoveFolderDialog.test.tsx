// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

const mocks = vi.hoisted(() => {
  const runtimeEnvironments: { id: string; name: string }[] = []
  return {
    state: {
      activeModal: 'confirm-remove-folder' as string | null,
      modalData: {
        repoId: 'repo-1',
        displayName: 'Example',
        hostId: 'ssh:target-1'
      } as Record<string, unknown>,
      repos: [] as Repo[],
      runtimeEnvironments,
      sshTargetLabels: new Map<string, string>(),
      removedSshTargetLabels: new Map<string, string>(),
      closeModal: vi.fn(),
      removeProject: vi.fn()
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
      fallback
    )
}))

import RemoveFolderDialog from './RemoveFolderDialog'

function repo(connectionId: string | null, executionHostId: Repo['executionHostId']): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/example',
    displayName: 'Example',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git',
    connectionId,
    executionHostId
  }
}

describe('RemoveFolderDialog', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.state.modalData = {
      repoId: 'repo-1',
      displayName: 'Example',
      hostId: 'ssh:target-1'
    }
    mocks.state.repos = []
    mocks.state.runtimeEnvironments = []
    mocks.state.sshTargetLabels = new Map([['target-1', 'Persistent host']])
    mocks.state.removedSshTargetLabels = new Map()
    mocks.state.removeProject.mockResolvedValue({ status: 'removed' })
  })

  it('warns that VM recipe cleanup controls file deletion', () => {
    mocks.state.modalData.hostId = 'ssh:runtime-ssh-runtime-1'
    mocks.state.repos = [repo('runtime-ssh-runtime-1', 'ssh:runtime-ssh-runtime-1')]

    const html = renderToStaticMarkup(<RemoveFolderDialog />)

    expect(html).toContain('Its VM recipe determines whether the environment')
    expect(html).toContain('files are permanently deleted')
    expect(html).not.toContain('Its files stay on')
  })

  it('keeps the file-preservation promise for ordinary SSH projects', () => {
    mocks.state.repos = [repo('target-1', 'ssh:target-1')]

    const html = renderToStaticMarkup(<RemoveFolderDialog />)

    expect(html).toContain('Its files stay on Persistent host')
    expect(html).not.toContain('VM recipe')
  })

  it('closes on a removal the owning host confirmed', async () => {
    mocks.state.repos = [repo('target-1', 'ssh:target-1')]
    render(<RemoveFolderDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(mocks.state.removeProject).toHaveBeenCalledWith('repo-1', {
      hostId: 'ssh:target-1',
      errorFeedback: 'toast'
    })
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })

  // The owning runtime never answered, so the project is still registered there. The
  // dialog must stay open and name the host rather than close on a removal that did not happen.
  it('re-offers a client-only forget when the owning host never answers', async () => {
    mocks.state.modalData.hostId = 'runtime:env-1'
    mocks.state.repos = [repo(null, 'runtime:env-1')]
    mocks.state.runtimeEnvironments = [{ id: 'env-1', name: 'alexdevbox2' }]
    mocks.state.removeProject.mockResolvedValueOnce({ status: 'owner-unverifiable' })
    render(<RemoveFolderDialog />)

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(mocks.state.closeModal).not.toHaveBeenCalled()
    expect(screen.getByText(/alexdevbox2 did not answer/)).toBeInTheDocument()
    expect(screen.getByText(/returns if that host reconnects/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Remove from Orca' }))

    expect(mocks.state.removeProject).toHaveBeenLastCalledWith('repo-1', {
      hostId: 'runtime:env-1',
      errorFeedback: 'toast',
      mode: 'forget-local'
    })
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
  })
})
