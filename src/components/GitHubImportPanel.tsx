import { useCallback, useEffect, useRef, useState } from "react";
import {
  cloneGitHubRepo,
  createProject,
  getCloneStatus,
  getGitHubBranches,
  getGitHubRepos,
  getGitHubStatus,
  type GitHubBranch,
  type GitHubRepo,
  type GitHubStatus,
} from "../api";
import { useI18n } from "../i18n";
import GitHubDeviceConnect from "./github-import/GitHubDeviceConnect";
import GitHubImportWizard from "./github-import/GitHubImportWizard";
import type { WizardStep } from "./github-import/model";

interface GitHubImportPanelProps {
  onComplete: (result: { projectId: string; projectPath: string; branch: string }) => void;
  onCancel: () => void;
}

export default function GitHubImportPanel({ onComplete, onCancel }: GitHubImportPanelProps) {
  const { t } = useI18n();

  const [ghStatus, setGhStatus] = useState<GitHubStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const [step, setStep] = useState<WizardStep>("repo");

  const [repoSearch, setRepoSearch] = useState("");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [directInput, setDirectInput] = useState("");
  const [directInputError, setDirectInputError] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [patToken, setPatToken] = useState("");
  const [patLoading, setPatLoading] = useState(false);

  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  const [targetPath, setTargetPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [coreGoal, setCoreGoal] = useState("");
  const [cloneProgress, setCloneProgress] = useState(0);
  const [cloneStatus, setCloneStatus] = useState<string>("idle");
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshGitHubStatus = useCallback(() => {
    setStatusLoading(true);
    getGitHubStatus()
      .then(setGhStatus)
      .catch(() => setGhStatus(null))
      .finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => {
    refreshGitHubStatus();
  }, [refreshGitHubStatus]);

  const loadRepos = useCallback(async (query: string) => {
    setReposLoading(true);
    try {
      const result = await getGitHubRepos({ q: query || undefined, per_page: 30 });
      setRepos(result.repos);
    } catch {
      setRepos([]);
    } finally {
      setReposLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ghStatus?.connected) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      void loadRepos(repoSearch);
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [repoSearch, ghStatus, loadRepos]);

  useEffect(() => {
    if (ghStatus?.connected) {
      void loadRepos("");
    }
  }, [ghStatus, loadRepos]);

  const handleRepoSelect = useCallback(
    async (repo: GitHubRepo, pat?: string) => {
      setSelectedRepo(repo);
      setStep("branch");
      setBranchesLoading(true);
      setBranchError(null);
      setSelectedBranch(null);
      try {
        const result = await getGitHubBranches(repo.owner, repo.name, pat);
        setBranches(result.remote_branches);
      } catch (error: unknown) {
        setBranches([]);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("404") || message.includes("not_found") || message.includes("repo_not_found")) {
          setBranchError(
            t({
              ko: `리포지토리 ${repo.full_name}에 접근할 수 없습니다. 설정 → OAuth 탭에서 자체 GitHub OAuth App을 등록하면 Private 리포에 접근할 수 있습니다. 또는 아래에 PAT를 직접 입력하세요.`,
              en: `Cannot access repository ${repo.full_name}. Register your own GitHub OAuth App in Settings → OAuth tab for private repo access, or enter a PAT below.`,
              ja: `リポジトリ ${repo.full_name} にアクセスできません。設定 → OAuth タブで自前の GitHub OAuth App を登録するとプライベートリポにアクセスできます。または下に PAT を入力してください。`,
              zh: `Cannot access repository ${repo.full_name}. Register your own GitHub OAuth App in Settings → OAuth tab for private repo access, or enter a PAT below.`,
              de: `Kein Zugriff auf Repository ${repo.full_name}. Registrieren Sie Ihre eigene GitHub OAuth App unter Einstellungen → OAuth-Tab für privaten Repo-Zugriff, oder geben Sie unten ein PAT ein.`,
            }),
          );
        } else if (message.includes("token_invalid")) {
          setBranchError(
            t({
              ko: "PAT가 유효하지 않거나 만료되었습니다. 다시 확인해주세요.",
              en: "PAT is invalid or expired. Please check and try again.",
              ja: "PAT が無効か期限切れです。確認して再試行してください。",
              zh: "PAT is invalid or expired. Please check and try again.",
              de: "Das PAT ist ungültig oder abgelaufen. Bitte prüfen Sie es und versuchen Sie es erneut.",
            }),
          );
        } else {
          setBranchError(message);
        }
      } finally {
        setBranchesLoading(false);
      }
    },
    [t],
  );

  const handleDirectInput = useCallback(async () => {
    setDirectInputError(null);
    const input = directInput.trim();
    const match = input.match(/(?:(?:https?:\/\/)?github\.com\/)?([^/\s]+)\/([^/\s#?]+)/);
    if (!match) {
      setDirectInputError(
        t({
          ko: "형식: owner/repo 또는 GitHub URL",
          en: "Format: owner/repo or GitHub URL",
          ja: "形式: owner/repo または GitHub URL",
          zh: "Format: owner/repo or GitHub URL",
          de: "Format: owner/repo oder GitHub URL",
        }),
      );
      return;
    }
    const [, owner, rawRepo] = match;
    const repoName = rawRepo.replace(/\.git$/, "");
    const fakeRepo: GitHubRepo = {
      id: 0,
      name: repoName,
      full_name: `${owner}/${repoName}`,
      owner,
      private: true,
      description: null,
      default_branch: "main",
      updated_at: new Date().toISOString(),
      html_url: `https://github.com/${owner}/${repoName}`,
      clone_url: `https://github.com/${owner}/${repoName}.git`,
    };
    try {
      await handleRepoSelect(fakeRepo);
    } catch (error: unknown) {
      setDirectInputError(error instanceof Error ? error.message : String(error));
    }
  }, [directInput, t, handleRepoSelect]);

  const handlePatRetry = useCallback(async () => {
    if (!selectedRepo || !patToken.trim()) return;
    setPatLoading(true);
    setBranchError(null);
    await handleRepoSelect(selectedRepo, patToken.trim());
    setPatLoading(false);
  }, [selectedRepo, patToken, handleRepoSelect]);

  const handleBranchSelect = useCallback(
    (branchName: string) => {
      setSelectedBranch(branchName);
      setStep("clone");
      if (selectedRepo) {
        setProjectName(selectedRepo.name);
        setTargetPath(`~/Projects/${selectedRepo.name}`);
        setCoreGoal("");
      }
    },
    [selectedRepo],
  );

  const handleImport = useCallback(async () => {
    if (!selectedRepo || !selectedBranch) return;
    setCreating(true);
    setCloneError(null);
    setCloneStatus("cloning");
    setCloneProgress(0);

    try {
      const resolvedPath = targetPath.startsWith("~/") ? targetPath : targetPath;
      const result = await cloneGitHubRepo({
        owner: selectedRepo.owner,
        repo: selectedRepo.name,
        branch: selectedBranch,
        target_path: resolvedPath,
        pat: patToken.trim() || undefined,
      });

      if (result.already_exists) {
        setCloneStatus("done");
        setCloneProgress(100);
      } else if (result.clone_id) {
        const cloneId = result.clone_id;
        pollRef.current = setInterval(async () => {
          try {
            const status = await getCloneStatus(cloneId);
            setCloneProgress(status.progress);
            if (status.status === "done") {
              setCloneStatus("done");
              if (pollRef.current) clearInterval(pollRef.current);
            } else if (status.status === "error") {
              setCloneStatus("error");
              setCloneError(status.error || "Clone failed");
              if (pollRef.current) clearInterval(pollRef.current);
              setCreating(false);
            }
          } catch {
            // continue polling
          }
        }, 1000);
        return;
      }

      const project = await createProject({
        name: projectName.trim() || selectedRepo.name,
        project_path: result.target_path || resolvedPath,
        core_goal: coreGoal.trim() || `GitHub: ${selectedRepo.full_name} (${selectedBranch})`,
        github_repo: selectedRepo.full_name,
      });
      onComplete({ projectId: project.id, projectPath: result.target_path || resolvedPath, branch: selectedBranch });
    } catch (error: unknown) {
      setCloneStatus("error");
      setCloneError(error instanceof Error ? error.message : String(error));
      setCreating(false);
    }
  }, [selectedRepo, selectedBranch, targetPath, projectName, coreGoal, patToken, onComplete]);

  useEffect(() => {
    if (cloneStatus !== "done" || !creating || !selectedRepo || !selectedBranch) return;
    const resolvedPath = targetPath.startsWith("~/") ? targetPath : targetPath;
    createProject({
      name: projectName.trim() || selectedRepo.name,
      project_path: resolvedPath,
      core_goal: coreGoal.trim() || `GitHub: ${selectedRepo.full_name} (${selectedBranch})`,
      github_repo: selectedRepo.full_name,
    })
      .then((project) => {
        onComplete({ projectId: project.id, projectPath: resolvedPath, branch: selectedBranch });
      })
      .catch((error: unknown) => {
        setCloneError(error instanceof Error ? error.message : String(error));
        setCloneStatus("error");
      })
      .finally(() => setCreating(false));
  }, [cloneStatus, creating, selectedRepo, selectedBranch, targetPath, projectName, coreGoal, onComplete]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-sm text-[var(--text-secondary)]">
          {t({ ko: "확인 중...", en: "Checking...", ja: "確認中...", zh: "Checking...", de: "Wird geprüft..." })}
        </p>
      </div>
    );
  }

  if (!ghStatus?.connected) {
    return <GitHubDeviceConnect reason="not_connected" onConnected={refreshGitHubStatus} onCancel={onCancel} />;
  }

  return (
    <GitHubImportWizard
      step={step}
      selectedRepo={selectedRepo}
      selectedBranch={selectedBranch}
      repoSearch={repoSearch}
      repos={repos}
      reposLoading={reposLoading}
      directInput={directInput}
      directInputError={directInputError}
      branchError={branchError}
      patToken={patToken}
      patLoading={patLoading}
      branches={branches}
      branchesLoading={branchesLoading}
      targetPath={targetPath}
      projectName={projectName}
      coreGoal={coreGoal}
      cloneProgress={cloneProgress}
      cloneStatus={cloneStatus}
      cloneError={cloneError}
      creating={creating}
      onCancel={onCancel}
      onResetToRepo={() => {
        setStep("repo");
        setSelectedRepo(null);
        setSelectedBranch(null);
      }}
      onGoToBranch={() => {
        if (selectedRepo) setStep("branch");
      }}
      onGoToClone={() => {
        if (selectedBranch) setStep("clone");
      }}
      onRepoSearchChange={setRepoSearch}
      onDirectInputChange={(value) => {
        setDirectInput(value);
        setDirectInputError(null);
      }}
      onDirectInputSubmit={() => {
        void handleDirectInput();
      }}
      onRepoSelect={(repo) => {
        void handleRepoSelect(repo);
      }}
      onPatTokenChange={setPatToken}
      onPatRetry={() => {
        void handlePatRetry();
      }}
      onBranchSelect={handleBranchSelect}
      onProjectNameChange={setProjectName}
      onTargetPathChange={setTargetPath}
      onCoreGoalChange={setCoreGoal}
      onImport={() => {
        void handleImport();
      }}
      onBackToBranch={() => {
        setStep("branch");
        setCloneStatus("idle");
        setCloneError(null);
        setCreating(false);
      }}
    />
  );
}
