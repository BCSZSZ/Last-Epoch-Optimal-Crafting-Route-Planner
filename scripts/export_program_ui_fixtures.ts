import {writeFileSync} from 'node:fs';
import {experimentalFixtures} from '../src/test-support/experimental-fixtures';
import {detailedFixtures} from '../src/test-support/detailed-fixtures';
writeFileSync('artifacts/browser/program-ui-fixtures.json',JSON.stringify([
 ...experimentalFixtures().map(f=>({...f,id:'reference-'+f.id})),...experimentalFixtures(4,true).map(f=>({...f,id:'detailed-'+f.id})),...detailedFixtures()
],null,2));
