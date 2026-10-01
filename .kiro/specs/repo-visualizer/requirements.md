# Requirements Document

## Introduction

The GitHub Repository Visualizer is a web-based tool that transforms a public GitHub repository into a narrated, downloadable video. Given a repository URL, the system extracts the repository's metadata, README, codebase structure, spec documentation, releases, pull requests, and commit history, then synthesizes a video that explains what the repository is, what users can do with it, how to run it, how it works, which features make it useful, and how it has evolved. Repository capabilities are the primary subject of the video; releases, pull requests, and commits serve as supporting evidence of the repository's evolution. This enables developers to showcase their projects in a compelling video format without manual effort.

## Glossary

- **System**: The GitHub Repository Visualizer web application.
- **User**: A person interacting with the System through a web browser.
- **Repository_URL**: A fully-qualified HTTPS URL pointing to a public GitHub repository (e.g., `https://github.com/owner/repo`).
- **Repository_Analyzer**: The component responsible for fetching and parsing repository data from GitHub.
- **Repository_Metadata**: The repository's description, topics, star count, primary language, and license, as returned by the GitHub repository endpoint.
- **Storyboard**: An ordered sequence of slides, each containing a title, visual content, and optional narration text, generated from the repository data.
- **Storyboard_Section**: One of the narrative parts of the Storyboard, in order: overview ("What is this repository?"), capabilities ("What can I do with it?"), run instructions ("How do I run it?"), architecture and how-it-works ("How does it work?"), key features ("What are its key features?"), and evolution ("How has it evolved?").
- **Renderer**: The component responsible for converting the Storyboard into a video file.
- **Video_File**: An MP4-encoded video file produced by the Renderer.
- **Commit_History**: The ordered list of git commits associated with a repository, including metadata such as author, timestamp, and message.
- **Commit_Body**: The portion of a commit message following the first line, excluding leading blank lines and excluding git trailer lines (lines of the form `Token: value` such as `Signed-off-by:` or `Co-authored-by:`).
- **Pull_Request**: A merged pull request of the repository, including its number, title, description body, labels, merge timestamp, and author account type.
- **Significant_PR**: A Pull_Request that satisfies the selection criteria defined in Requirement 7.1.
- **Release**: A published, non-draft GitHub release of the repository, including its name, tag, publication timestamp, and release notes.
- **Change_Category**: A label describing the nature of a change, one of "Breaking Change", "Feature", "Bug Fix", or "Refactor".
- **Change_Context**: The first sentence of a Pull_Request body, Release notes, or Commit_Body, after removal of HTML comments, task-list lines, heading lines, and blank lines.
- **Spec_Documentation**: Markdown files located at any depth under the `.kiro/specs/` directory of the repository, such as each spec's `requirements.md` and `design.md`.
- **Capability**: A statement of something a user can accomplish with the repository.
- **Key_Feature**: A specific feature, component, or mechanism of the repository that makes one or more Capabilities possible.
- **Evolution_Timeline**: A single slide listing notable Releases and Significant_PRs in chronological order.
- **Anchor_Term**: A lowercase alphanumeric token of at least `SLIDE_CONFIG.relevanceMinTermLength` characters taken from the extracted Capabilities, Key_Feature names, and how-it-works headings, excluding the generic words listed in the design document. Two terms match when they are identical or one begins with the other.
- **Relevant_Change**: A Significant_PR, Release, or commit whose title or Change_Context contains a term that matches at least one Anchor_Term, indicating that the change helps explain the repository's current capabilities or architecture.
- **Patch_Release**: A Release whose tag has the form `X.Y.Z` or `vX.Y.Z` with a patch component `Z` greater than 0.
- **Engineering_Highlight**: A commit from the Commit_History selected as fallback or supplementary evidence of a notable change, as defined in Requirement 7.9.
- **Merge_Commit**: A commit in the Commit_History that has two or more parent commits.
- **Change_Group**: The set of commits in the Commit_History that make up one logical change. Change_Groups are determined only from commit parent identifiers and Pull_Request merge commit identifiers returned by the GitHub API, using only commits present in the Commit_History, as defined in Requirement 7.17. They are never determined from commit message text, and commits or ancestry absent from the Commit_History are never inferred.
- **Selected_PR**: A Pull_Request chosen to receive a notable-change slide under Requirement 7.5.
- **PR_Commit_Evidence**: The commit identifiers that GitHub returns as the commits of a Selected_PR, obtained under Requirement 2.11. A commit in the Commit_History belongs to a Selected_PR when its identifier is in that Pull_Request's Change_Group (membership proven from the commit graph) or in its PR_Commit_Evidence (membership reported by GitHub). Neither source is inferred from commit message text.
- **Window_Path**: A chain of parent links in which every commit, including both ends, is present in the Commit_History.
- **Detailed_Evolution_Slide**: A notable-change slide or an Engineering_Highlight slide. The Evolution_Timeline slide is not a Detailed_Evolution_Slide.
- **Progress_Indicator**: A UI element that communicates the current rendering progress as a percentage value between 0 and 100.
- **Run_Instructions**: Setup or usage steps extracted from the repository README, identified by a section heading matching (case-insensitive) one of "Installation", "Getting Started", "Setup", "Usage", or "Quick Start", including any fenced code block within that section.
- **Target_Duration**: A User-selected desired total video length, in seconds, constrained to the inclusive range from the minimum video duration to the maximum video duration defined in the output configuration.

---

## Requirements

### Requirement 1: Repository URL Input and Validation

**User Story:** As a User, I want to submit a GitHub repository URL, so that the System can identify and fetch the correct repository for visualization.

#### Acceptance Criteria

1. THE System SHALL provide a text input field for the User to enter a Repository_URL of up to 2048 characters.
2. WHEN the User submits a Repository_URL, THE System SHALL validate that the URL matches the pattern `https://github.com/{owner}/{repo}` where `{owner}` and `{repo}` each contain only alphanumeric characters, hyphens, or underscores, and are between 1 and 100 characters in length, before making any external requests.
3. IF the submitted Repository_URL does not match the required URL pattern, THEN THE System SHALL display an inline error message describing the expected format and prevent further processing.
4. WHEN the Repository_URL passes format validation, THE System SHALL verify that the repository is publicly accessible via the GitHub API within 10 seconds.
5. IF the repository is not publicly accessible or does not exist, THEN THE System SHALL display an error message stating the repository could not be reached, clear the loading indicator, and prompt the User to enter a different Repository_URL.
6. IF the GitHub API does not respond within 10 seconds, THEN THE System SHALL display an error message indicating the request timed out, clear the loading indicator, and prompt the User to try again.
7. WHILE the System is verifying repository accessibility, THE System SHALL display a loading indicator and disable the submit control to prevent duplicate submissions.

---

### Requirement 2: Repository Analysis and Data Extraction

**User Story:** As a User, I want the System to automatically analyze a repository, so that I do not have to manually select or upload repository content.

#### Acceptance Criteria

1. WHEN repository accessibility is confirmed, THE Repository_Analyzer SHALL fetch the top-level directory structure of the repository up to three directory levels deep.
2. WHEN the repository contains a `README.md` file, THE Repository_Analyzer SHALL extract the full text content of the root-level `README.md`, up to a maximum of 1 MB, in preference to any nested `README.md` files.
3. WHEN the repository contains a `.kiro/specs/` directory, THE Repository_Analyzer SHALL extract up to 6 Markdown files located at any depth under `.kiro/specs/` as Spec_Documentation, regardless of the three-level depth limit in Requirement 2.1, selecting files named `requirements.md` or `design.md` before any other files and ordering files of equal priority by ascending path, and skipping any individual file whose size exceeds 1 MB.
4. WHEN repository analysis is initiated, THE Repository_Analyzer SHALL extract the 50 most recent commits from the default branch of the repository, including each commit's author name, timestamp, message subject (first line), Commit_Body, and parent commit identifiers, using only the data returned by the commits request.
5. IF the GitHub API returns a rate-limit error during data extraction, THEN THE Repository_Analyzer SHALL display an error message indicating the rate limit has been reached and advise the User of the actual time to wait before retrying, derived from the GitHub `Retry-After` or `X-RateLimit-Reset` response headers; WHEN neither header is available, THE Repository_Analyzer SHALL advise the User to try again later without promising a specific duration.
6. IF any individual data extraction step fails for a reason other than rate-limiting, THEN THE Repository_Analyzer SHALL skip the failing step, continue extracting remaining data, and notify the User that partial data was retrieved.
7. WHEN repository analysis is initiated, THE Repository_Analyzer SHALL extract the Repository_Metadata of the repository.
8. WHEN repository analysis is initiated, THE Repository_Analyzer SHALL retrieve the 50 most recently updated closed pull requests of the repository and retain only those with a merge timestamp as Pull_Requests, including each Pull_Request's merge commit identifier when GitHub provides one, using only the data returned by the pull requests request.
9. WHEN repository analysis is initiated, THE Repository_Analyzer SHALL retrieve up to 10 of the most recent releases of the repository and retain only published, non-draft releases as Releases.
10. IF the repository has no Pull_Requests, no Releases, or no `.kiro/specs/` directory, THEN THE Repository_Analyzer SHALL return an empty result for that data source and SHALL NOT report that data source as a partial failure.
11. WHEN Storyboard generation has selected the Selected_PRs, THE Repository_Analyzer SHALL retrieve PR_Commit_Evidence only for Selected_PRs whose membership cannot already be determined from the Commit_History, using at most one request per such Selected_PR and at most 3 requests in total, and SHALL make no such request when no Selected_PR requires one. THE Repository_Analyzer SHALL NOT retrieve the commits of any Pull_Request that is not a Selected_PR.
12. IF retrieving the PR_Commit_Evidence for a Selected_PR fails for any reason, including a timeout, an error response, or a rate-limit response, THEN THE System SHALL continue Storyboard generation using only the Change_Groups determined under Requirement 7.17 for that Selected_PR, and SHALL NOT fail repository analysis or Storyboard generation.

---

### Requirement 3: Storyboard Structure and Generation

**User Story:** As a User, I want the System to organize the repository's content into a clear narrative, so that the generated video explains what the repository does before describing how it has changed.

#### Acceptance Criteria

1. THE System SHALL order the Storyboard as: overview slide first; Capabilities slide (if present); Run_Instructions slide (if present); architecture overview slide; how-it-works slide (if present); Key_Feature slides (if present); Evolution_Timeline slide (if present); notable-change slides, including Engineering_Highlight slides (if present); and conclusion slide last.
2. THE System SHALL generate a Storyboard containing a minimum of 3 slides and a maximum of 15 slides.
3. THE System SHALL limit the combined number of Evolution_Timeline, notable-change, and Engineering_Highlight slides to `SLIDE_CONFIG.maxEvolutionSlides`, so that evolution content does not displace the slides describing what the repository currently does.
4. IF the assembled Storyboard exceeds 15 slides, THEN THE System SHALL remove slides in the following order until the Storyboard contains 15 slides: Engineering_Highlight slides from last to first, then notable-change slides from lowest-ranked to highest-ranked, then the Evolution_Timeline slide, then Key_Feature slides from last to first; THE System SHALL NOT remove the overview, Capabilities, Run_Instructions, architecture overview, how-it-works, or conclusion slides to satisfy this limit.
5. WHEN Storyboard generation is complete, THE System SHALL display a preview of all Storyboard slides to the User, where each slide preview shows the slide title and a text summary of up to 50 words, before video rendering begins.
6. WHEN the User reviews the Storyboard preview, THE System SHALL allow the User to reorder slides by changing their position index and remove individual slides, subject to the constraint that the resulting Storyboard contains no fewer than 3 slides and no more than 15 slides, before the User initiates video rendering.
7. IF repository data contains insufficient content to generate 3 slides, THEN THE System SHALL display an error message indicating that the repository has insufficient content, and halt the visualization process without modifying any previously stored data.
8. IF the User attempts to remove a slide that would reduce the Storyboard below 3 slides, THEN THE System SHALL reject the removal and display an error message indicating the minimum slide count of 3 has been reached.
9. IF no data source provides content for a Storyboard_Section, THEN THE System SHALL omit that section's optional slides without raising an error, and THE System SHALL NOT generate slide content that is not present in the extracted repository data.
10. THE System SHALL generate a conclusion slide containing the repository name and GitHub URL, and WHEN Repository_Metadata is available, THE System SHALL include the star count, primary language, and license on the conclusion slide.
11. THE System SHALL HTML-escape all text extracted from repository data before placing it in any slide title, body, or preview summary.
12. THE System SHALL treat `SLIDE_CONFIG.maxFeatureSlides`, `SLIDE_CONFIG.maxEvolutionSlides`, and the 15-slide maximum as upper bounds rather than targets, and SHALL NOT add, split, or repeat content solely to reach any of them.
13. THE System SHALL NOT derive the content of the overview, Capabilities, Run_Instructions, how-it-works, or Key_Feature slides, or the Anchor_Terms, from the Commit_History, Pull_Requests, or Releases.

---

### Requirement 4: Video Rendering and Download

**User Story:** As a User, I want to download a video file generated from the Storyboard, so that I can share my project with others.

#### Acceptance Criteria

1. WHEN the User initiates video export, THE Renderer SHALL convert each Storyboard slide into a video frame sequence at a resolution of 1280×720 pixels and 30 frames per second.
2. THE Renderer SHALL encode the frame sequence into a Video_File using the H.264 codec in MP4 container format.
3. WHILE video rendering is in progress, including both frame preparation and video encoding, THE System SHALL update the Progress_Indicator with the current rendering completion percentage as a value between 0 and 100, at intervals no greater than `VIDEO_CONFIG.progressIntervalMs`, regardless of how often the video encoder reports its own progress.
4. WHEN rendering is complete, THE System SHALL make the Video_File available for the User to download via the browser within 5 seconds of completion.
5. THE Renderer SHALL produce a Video_File with a minimum duration of 30 seconds and a maximum duration of 5 minutes.
6. WHEN the rendered Video_File exceeds 200 MB, THE System SHALL display the file size in megabytes and require explicit User confirmation before initiating the download.
7. IF the rendering process fails before completion, THEN THE System SHALL display an error message describing the failure, discard any partially generated Video_File, and offer the User the option to retry rendering.
8. WHEN the User cancels rendering before completion, THE System SHALL stop the rendering process within 3 seconds and discard any partially generated Video_File.
9. IF the User initiates video export with an empty Storyboard containing zero slides, THEN THE System SHALL display an error message indicating that at least one slide is required and prevent the rendering process from starting.
10. BEFORE initiating video export, THE System SHALL allow the User to select a Target_Duration in seconds, constrained to the inclusive range from `VIDEO_CONFIG.minDurationSeconds` to `VIDEO_CONFIG.maxDurationSeconds`.
11. WHEN the User has not selected a Target_Duration, THE System SHALL derive a default Target_Duration from the slide count using the existing duration calculation, clamped to the inclusive range from `VIDEO_CONFIG.minDurationSeconds` to `VIDEO_CONFIG.maxDurationSeconds`.
12. IF the User submits a Target_Duration outside the inclusive range from `VIDEO_CONFIG.minDurationSeconds` to `VIDEO_CONFIG.maxDurationSeconds`, THEN THE System SHALL reject the render request with an `invalid_input` error and an HTTP 400 response stating the permitted range, and prevent the rendering process from starting.
13. WHEN a valid Target_Duration is provided, THE Renderer SHALL distribute the Target_Duration across the Storyboard slides so that the total Video_File duration equals the Target_Duration to within one second per slide of rounding, while keeping each slide on screen for at least 1 second.
14. THE Renderer SHALL produce a Video_File whose duration remains within the minimum and maximum bounds defined in Requirement 4.5, and THE System SHALL NOT accept a Target_Duration outside those bounds.
15. WHEN rendering a slide, THE Renderer SHALL wrap the slide title and body text at word boundaries so that no rendered line extends beyond the slide's text area, preserving explicit line breaks in the source text, and SHALL break a single word across lines only when that word alone is wider than the text area.
16. IF the wrapped slide body text exceeds the vertical space available on the slide, THEN THE Renderer SHALL render only the lines that fit in full and SHALL end the last rendered line with an ellipsis to indicate truncation.
17. WHILE video rendering is in progress, THE System SHALL report a completion percentage that never decreases and that stays below 100, and WHEN rendering completes successfully, THE System SHALL report 100 exactly once, together with the identifier of the completed Video_File.
18. WHEN rendering completes, fails, or is cancelled through the existing cancellation request, OR WHEN the User's connection to the progress stream closes, THE System SHALL stop all progress reporting for that render, release its progress timers, and SHALL NOT send further progress events on that connection.

---

### Requirement 5: Repository Overview, Capabilities, and Run Instructions

**User Story:** As a User, I want the video to explain what the repository is, what I can do with it, and how to run it, so that viewers understand the repository's purpose before its internals.

#### Acceptance Criteria

1. THE System SHALL generate an overview slide containing the repository name; WHEN Repository_Metadata is available, THE System SHALL include the repository description and topics; and WHEN a `README.md` is available, THE System SHALL include the first prose paragraph of the `README.md`, excluding heading, badge, image, and HTML lines, truncated to `SLIDE_CONFIG.introMaxWords` words, where a word is defined as a whitespace-delimited token.
2. IF neither a repository description nor a README prose paragraph is available, THEN THE System SHALL generate the overview slide with the repository name and a statement that no description is available.
3. WHEN a `README.md` is available AND it contains a section whose heading matches (case-insensitive) one of "Capabilities", "What it does", "What you can do", or "Use Cases", THE System SHALL generate a Capabilities slide listing up to `SLIDE_CONFIG.capabilitiesMaxItems` Capabilities extracted from the list items or sentences of the first matching section, each truncated to `SLIDE_CONFIG.capabilityMaxWords` words.
4. IF no README capabilities section exists AND Spec_Documentation contains user stories of the form "As a …, I want …, so that …", THEN THE System SHALL generate the Capabilities slide from the "I want" clause of up to `SLIDE_CONFIG.capabilitiesMaxItems` user stories in document order, each truncated to `SLIDE_CONFIG.capabilityMaxWords` words.
5. IF more than `SLIDE_CONFIG.capabilitiesMaxOverlapRatio` of the extracted Capabilities match an extracted Key_Feature, where a match means the normalized text (case-insensitive, with punctuation and repeated whitespace removed) of one contains the normalized text of the other, THEN THE System SHALL omit the Capabilities slide.
6. IF no README capabilities section and no Spec_Documentation user stories are available, THEN THE System SHALL omit the Capabilities slide without raising an error.
7. WHEN a `README.md` is available AND it contains a section whose heading matches (case-insensitive) one of "Installation", "Getting Started", "Setup", "Usage", or "Quick Start", THE System SHALL generate a dedicated Run_Instructions Storyboard slide summarizing that section, where the slide includes the matched heading and up to `SLIDE_CONFIG.runMaxSteps` steps or lines extracted from the section body, each step truncated to `SLIDE_CONFIG.runMaxWordsPerStep` words.
8. WHEN a matched Run_Instructions section contains a fenced code block, THE System SHALL prefer the contents of the first fenced code block in that section as the Run_Instructions steps, up to `SLIDE_CONFIG.runMaxSteps` lines.
9. IF more than one heading matches the Run_Instructions keywords, THEN THE System SHALL select the first matching section in document order.
10. IF no `README.md` is available OR no heading matches the Run_Instructions keywords, THEN THE System SHALL omit the Run_Instructions slide without raising an error.
11. THE System SHALL position the Run_Instructions slide immediately after the Capabilities slide when the Capabilities slide is present, and immediately after the overview slide otherwise.

---

### Requirement 6: How the Repository Works and Its Key Features

**User Story:** As a User, I want the video to explain how the repository works and which features make its capabilities possible, so that viewers understand the mechanisms behind what the repository does.

#### Acceptance Criteria

1. THE System SHALL generate an architecture overview slide showing the top-level directory structure of the repository, listing directories before files.
2. WHEN a `README.md` is available AND it contains a section whose heading matches (case-insensitive) one of "How it works", "Architecture", or "Design", THE System SHALL generate a how-it-works slide containing the matched heading and up to `SLIDE_CONFIG.specMaxSentences` sentences from the first matching section.
3. IF no README how-it-works section exists AND Spec_Documentation is available, THEN THE System SHALL generate the how-it-works slide from the Spec_Documentation, including the document title, a list of up to `SLIDE_CONFIG.specMaxHeadings` section headings, and up to `SLIDE_CONFIG.specMaxSentences` sentences extracted from sections whose headings contain the words "design", "architecture", or "decision".
4. IF no README how-it-works section and no Spec_Documentation are available, THEN THE System SHALL omit the how-it-works slide without raising an error.
5. WHEN a `README.md` is available AND it contains a section whose heading matches (case-insensitive) one of "Features", "Key Features", or "Highlights", THE System SHALL extract each list item of the first matching section as a Key_Feature, with a feature name (the item's bold lead text, or the text preceding the first colon or dash) and, where present, a feature description truncated to `SLIDE_CONFIG.featureMaxWords` words.
6. IF no README features section exists AND Spec_Documentation contains a design document with a section whose heading contains "Components", THEN THE System SHALL extract each subheading of that section as a Key_Feature, with the subheading as the feature name and the first sentence beneath it, where present, as the feature description truncated to `SLIDE_CONFIG.featureMaxWords` words.
7. IF neither a README features section nor a design document components section is available AND Spec_Documentation contains requirement headings of the form "Requirement N: Title", THEN THE System SHALL extract each requirement title as a Key_Feature name without a description.
8. IF no Key_Feature source is available, THEN THE System SHALL omit the Key_Feature slides without raising an error.
9. THE System SHALL generate one Key_Feature slide for each extracted Key_Feature that has a description, in document order; IF any extracted Key_Features have no description, THEN THE System SHALL list their names on a single Key_Feature summary slide placed after the individual Key_Feature slides and SHALL NOT generate an individual slide for a Key_Feature without a description; the individual and summary Key_Feature slides together SHALL NOT exceed `SLIDE_CONFIG.maxFeatureSlides`.

---

### Requirement 7: Repository Evolution

**User Story:** As a User, I want the video to summarize how the repository has evolved through its notable releases and changes, so that viewers understand its history without the video becoming a changelog.

#### Acceptance Criteria

1. THE System SHALL treat a Pull_Request as a Significant_PR only if its author account is not a bot account, its title does not begin with one of the conventional-commit types "chore", "docs", "ci", "style", "test", or "build", its title does not contain any of the words "bump", "deps", "dependency", or "dependencies" (case-insensitive), and a Change_Category can be assigned to it under Requirement 7.2.
2. THE System SHALL assign a Change_Category to a Pull_Request using, in order of precedence: its labels ("breaking-change" or "breaking" → "Breaking Change"; "feature" or "enhancement" → "Feature"; "bug" → "Bug Fix"; "refactor" → "Refactor"); then a conventional-commit title prefix (a `!` before the colon → "Breaking Change"; "feat" → "Feature"; "fix" → "Bug Fix"; "refactor" → "Refactor"); then the first of the keywords "feat", "add", or "implement" (→ "Feature"), "fix" (→ "Bug Fix"), or "refactor" or "redesign" (→ "Refactor") that appears in its title using case-insensitive substring matching.
3. THE System SHALL rank Significant_PRs by Change_Category in the order "Breaking Change", "Feature", "Bug Fix", "Refactor", and within the same Change_Category by more recent merge timestamp first.
4. WHEN at least `SLIDE_CONFIG.minEvolutionItems` timeline entries are eligible, THE System SHALL generate an Evolution_Timeline slide listing up to `SLIDE_CONFIG.maxEvolutionItems` entries in chronological order from oldest to newest, where eligible entries are Releases that are not Patch_Releases and Significant_PRs that are Relevant_Changes; THE System SHALL select the most recent eligible Releases first and fill the remaining entries with the highest-ranked eligible Significant_PRs, where each entry shows its date, its label ("Release" or the Change_Category), and its title (the Release name or tag, or the Pull_Request title).
5. WHEN Significant_PRs that are Relevant_Changes and whose Change_Category is not "Bug Fix" are available, THE System SHALL generate notable-change slides for the highest-ranked of them, up to the number of evolution slides remaining under Requirement 3.3, where each slide shows the Change_Category as a label next to the title, the Pull_Request number, the merge date, and the Change_Context truncated to `SLIDE_CONFIG.changeContextMaxWords` words.
6. IF fewer eligible Significant_PRs are available under Requirement 7.5 than the evolution slides remaining under Requirement 3.3, THEN THE System SHALL generate notable-change slides for the most recent Releases that are not Patch_Releases, that are Relevant_Changes, and whose release notes contain a Change_Context, where each slide shows the Release name or tag, the publication date, and the Change_Context truncated to `SLIDE_CONFIG.changeContextMaxWords` words.
7. IF a Pull_Request body or Release notes contain no Change_Context, THEN THE System SHALL generate that notable-change slide from its title and dates only, and SHALL NOT generate or infer any additional context.
8. IF no Releases and no Significant_PRs are available, THEN THE System SHALL omit the Evolution_Timeline slide and use Engineering_Highlights as the only evolution content.
9. WHEN at least one Anchor_Term has been extracted AND evolution slides remain available under Requirement 3.3 after notable-change slides for Significant_PRs and Releases have been generated, THE System SHALL identify up to 10 Engineering_Highlights from the Commit_History by selecting commits whose message subjects contain at least one of the keywords "feat", "fix", "refactor", "add", "implement", or "redesign" using case-insensitive substring matching, excluding any commit excluded by Requirement 7.15, any commit whose Change_Category under Requirement 7.10 is "Bug Fix", and any commit that is not a Relevant_Change, and SHALL generate Engineering_Highlight slides from the remaining commits in commit-history order, up to the number of evolution slides remaining.
10. WHEN generating an Engineering_Highlight slide, THE System SHALL show the Change_Category assigned from the commit subject using the keyword mapping in Requirement 7.2 as a label next to the title, together with the commit subject, author, and date; and WHEN the commit has a Commit_Body, THE System SHALL include its Change_Context truncated to `SLIDE_CONFIG.changeContextMaxWords` words.
11. IF a commit has no Commit_Body, or its Commit_Body contains only trailer lines, THEN THE System SHALL generate the Engineering_Highlight slide from the commit subject, author, and date only, and SHALL NOT generate or infer any additional context.
12. IF no Releases, no Significant_PRs, and no Engineering_Highlights are available, THEN THE System SHALL omit all evolution slides without raising an error.
13. THE System SHALL NOT include a Pull_Request, Release, or commit in any evolution slide unless it satisfies the eligibility criteria of Requirements 7.4, 7.5, 7.6, 7.9, or 7.14, even when evolution slides remain available under Requirement 3.3.
14. IF no Anchor_Term has been extracted, THEN THE System SHALL, in place of Requirement 7.9, select as Engineering_Highlights only commits whose subject begins with the conventional-commit type "feat" (in the forms `feat:`, `feat(scope):`, `feat!:`, or `feat(scope)!:`), excluding any commit whose subject contains one of the words "bump", "deps", "dependency", or "dependencies" (case-insensitive) and any commit excluded by Requirement 7.15; THE System SHALL generate Engineering_Highlight slides from the most recent of these commits, up to `SLIDE_CONFIG.maxFallbackHighlights` slides and no more than the number of evolution slides remaining under Requirement 3.3, and SHALL NOT use keyword substring matches, other commit types, or these commits as a source of Capabilities, Key_Features, or Anchor_Terms.
15. THE System SHALL represent each Selected_PR's change with at most one Detailed_Evolution_Slide: THE System SHALL exclude from Engineering_Highlight selection every commit that belongs to a Selected_PR. THE System SHALL also select at most one Engineering_Highlight per Change_Group, and SHALL NOT select a Merge_Commit as an Engineering_Highlight. Appearing on the Evolution_Timeline SHALL NOT count as a Detailed_Evolution_Slide, so a Pull_Request MAY appear both on the Evolution_Timeline and as a notable-change slide. THE choice of Selected_PRs SHALL NOT depend on PR_Commit_Evidence.
16. IF a Pull_Request's merge commit is absent from the Commit_History or unavailable from GitHub, THEN THE System SHALL treat that Pull_Request's Change_Group as unknown and SHALL apply Requirement 7.15 using the Change_Groups that can be determined; IF Pull_Request data is unavailable, THEN THE System SHALL determine Change_Groups from Merge_Commits alone.
17. THE System SHALL determine Change_Groups from the Commit_History alone, as follows:
    - For each Merge_Commit, processed from most recent to least recent, the Change_Group contains the Merge_Commit together with each commit that is reachable from the Merge_Commit's second parent by a Window_Path and is provably not an ancestor of its first parent. Non-ancestry is provable only when the first parent's ancestry is fully contained in the Commit_History, meaning every commit reachable from the first parent by a Window_Path has all of its parents in the Commit_History. IF the first parent's ancestry reaches a parent that is not in the Commit_History, THEN the Change_Group SHALL contain only the Merge_Commit.
    - For a Pull_Request whose merge commit is a single-parent commit in the Commit_History, the Change_Group is that commit alone.
    - Every other commit is a Change_Group by itself.
    - A commit SHALL belong to at most one Change_Group; a commit already assigned keeps its first assignment.
    - THE System SHALL NOT add to a Change_Group any commit that is not present in the Commit_History, and SHALL NOT assume parent relationships that pass through commits outside the Commit_History. Change_Group membership is therefore limited to the fetched Commit_History and may be partial when a change extends beyond it.
18. WHEN a Pull_Request was merged by rebasing, THE System SHALL associate only that Pull_Request's merge commit with the Pull_Request; its other rebased commits form Change_Groups by themselves and MAY each qualify independently for Engineering_Highlight selection. THE System SHALL NOT use commit message text to associate those commits with the Pull_Request, and SHALL treat PR_Commit_Evidence as membership only for identifiers that exactly match commits in the Commit_History.
