---
status: accepted
---

# Delete superseded nightly releases

After each stable release, Mcode deletes every nightly release and corresponding
tag that is more than seven days old and whose intended version is equal to or
older than that stable version. The cutoff is fixed relative to the triggering
stable release, so a delayed retry cannot age newer nightlies into the deletion
set. This includes eligible draft and incomplete nightlies. Stable releases,
recent nightlies, and nightlies for later versions remain available.
Superseded nightlies have no rollback or support role, so retaining them would
only grow the release and tag lists without bound.
