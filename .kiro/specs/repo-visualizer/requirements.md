# Requirements Document

## Introduction

The GitHub Repository Visualizer is a web-based tool that transforms a public GitHub repository into a narrated, downloadable video. Given a repository URL, the system extracts the codebase structure, README, commit history, and spec documentation, then synthesizes an engaging video that highlights the project's architecture, engineering milestones, and core features. This enables developers to showcase their projects in a compelling video format without manual effort.

## Glossary

- **System**: The GitHub Repository Visualizer web application.
- **User**: A person interacting with the System through a web browser.
- **Repository_URL**: A fully-qualified HTTPS URL pointing to a public GitHub repository (e.g., `https://github.com/owner/repo`).
- **Repository_Analyzer**: The component responsible for fetching and parsing repository data from GitHub.
- **Storyboard**: An ordered sequence of slides, each containing a title, visual content, and optional narration text, generated from the repository data.
- **Renderer**: The component responsible for converting the Storyboard into a video file.
- **Video_File**: An MP4-encoded video file produced by the Renderer.
- **Commit_History**: The ordered list of git commits associated with a repository, including metadata such as author, timestamp, and message.
- **Spec_Documentation**: Files located within `.kiro` directories in the repository, including spec files and configuration.
- **Engineering_Highlight**: A notable commit, architectural decision, or project milestone extracted from repository data.
- **Progress_Indicator**: A UI element that communicates the current rendering progress as a percentage value between 0 and 100.

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
3. WHEN the repository contains a `.kiro` directory, THE Repository_Analyzer SHALL extract all files within that directory as Spec_Documentation, skipping any individual file whose size exceeds 1 MB.
4. WHEN repository analysis is initiated, THE Repository_Analyzer SHALL extract the 50 most recent commits from the default branch of the repository, including each commit's author name, timestamp, and message.
5. IF the GitHub API returns a rate-limit error during data extraction, THEN THE Repository_Analyzer SHALL display an error message indicating the rate limit has been reached and advise the User to retry after 60 seconds.
6. IF any individual data extraction step fails for a reason other than rate-limiting, THEN THE Repository_Analyzer SHALL skip the failing step, continue extracting remaining data, and notify the User that partial data was retrieved.

---

### Requirement 3: Content Highlighting and Storyboard Generation

**User Story:** As a User, I want the System to identify the most important aspects of the repository, so that the generated video communicates the project's value clearly.

#### Acceptance Criteria

1. WHEN repository data extraction is complete, THE System SHALL identify up to 10 Engineering_Highlights from the Commit_History by selecting commits whose messages contain at least one of the keywords "feat", "fix", "refactor", "add", "implement", or "redesign" using case-insensitive substring matching.
2. WHEN a `README.md` is available, THE System SHALL extract the first 300 words of the `README.md` as a project introduction slide, where a word is defined as a whitespace-delimited token.
3. WHEN Spec_Documentation is available, THE System SHALL generate a dedicated Storyboard slide summarizing the spec structure and key design decisions, where the slide includes the document title, a list of up to 5 section headings, and up to 3 sentences extracted from sections whose headings contain the words "design", "architecture", or "decision".
4. THE System SHALL generate a Storyboard containing a minimum of 3 slides and a maximum of 15 slides, ordered as: introduction slide first, architecture overview slide second, Engineering_Highlights slides in the middle, and conclusion slide last.
5. WHEN Storyboard generation is complete, THE System SHALL display a preview of all Storyboard slides to the User, where each slide preview shows the slide title and a text summary of up to 50 words, before video rendering begins.
6. WHEN the User reviews the Storyboard preview, THE System SHALL allow the User to reorder slides by changing their position index and remove individual slides, subject to the constraint that the resulting Storyboard contains no fewer than 3 slides and no more than 15 slides, before the User initiates video rendering.
7. IF repository data contains insufficient content to generate 3 slides, THEN THE System SHALL display an error message indicating that the repository has insufficient content, and halt the visualization process without modifying any previously stored data.
8. IF the User attempts to remove a slide that would reduce the Storyboard below 3 slides, THEN THE System SHALL reject the removal and display an error message indicating the minimum slide count of 3 has been reached.

---

### Requirement 4: Video Rendering and Download

**User Story:** As a User, I want to download a video file generated from the Storyboard, so that I can share my project with others.

#### Acceptance Criteria

1. WHEN the User initiates video export, THE Renderer SHALL convert each Storyboard slide into a video frame sequence at a resolution of 1280×720 pixels and 30 frames per second.
2. THE Renderer SHALL encode the frame sequence into a Video_File using the H.264 codec in MP4 container format.
3. WHILE video rendering is in progress, THE System SHALL update the Progress_Indicator with the current rendering completion percentage as a value between 0 and 100, updating at intervals no greater than 2 seconds.
4. WHEN rendering is complete, THE System SHALL make the Video_File available for the User to download via the browser within 5 seconds of completion.
5. THE Renderer SHALL produce a Video_File with a minimum duration of 30 seconds and a maximum duration of 5 minutes.
6. WHEN the rendered Video_File exceeds 200 MB, THE System SHALL display the file size in megabytes and require explicit User confirmation before initiating the download.
7. IF the rendering process fails before completion, THEN THE System SHALL display an error message describing the failure, discard any partially generated Video_File, and offer the User the option to retry rendering.
8. WHEN the User cancels rendering before completion, THE System SHALL stop the rendering process within 3 seconds and discard any partially generated Video_File.
9. IF the User initiates video export with an empty Storyboard containing zero slides, THEN THE System SHALL display an error message indicating that at least one slide is required and prevent the rendering process from starting.
