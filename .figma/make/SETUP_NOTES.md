# Figma Make setup notes

Bootstrap is configured for the static frontend with Vite.

Figma Make deployment is intentionally not configured. This repository relies
on the Vercel serverless functions in `api/` for recipe import, document export,
and card image discovery. Publishing only the static Vite output would make
those routes unavailable. Keep Vercel as the production deployment target
unless the serverless routes are migrated to a runtime supported by Figma Make.

`figma make verify-deploy-preview --skip` is the expected preview outcome for
this repository. `figma make verify-deploy` cannot pass safely without changing
the deployment architecture.
