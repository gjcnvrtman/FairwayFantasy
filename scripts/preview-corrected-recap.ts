// Render the corrected-recap template against mock data so the bold
// + banner treatment can be eyeballed before any real send.
import { writeFileSync } from 'fs';
import { tournamentRecapEmail } from '../src/lib/email';

const out = tournamentRecapEmail({
  displayName:    'Greg',
  leagueName:     'Royal Duffers',
  leagueSlug:     'royal-duffers',
  tournamentName: 'RBC Canadian Open',
  leaderboard: [
    { rank: 1, displayName: 'Rory Jones',             totalScore: -28, isMe: false },
    { rank: 2, displayName: 'Marge',                  totalScore: -26, isMe: false },
    { rank: 3, displayName: 'Golly I’m Hot Today!', totalScore: -25, isMe: false },
    { rank: 4, displayName: 'The Dali Llama Himself', totalScore: -20, isMe: true  },
    { rank: 5, displayName: 'Nick Lucca',             totalScore: -10, isMe: false },
  ],
  bestRound:      { roundNum: 4, score: -5, golfer: 'Viktor Hovland' },
  seasonStandings: [
    { rank: 1,  displayName: 'Rory Jones',             totalScore: -94, tournamentsPlayed: 3, isMe: false },
    { rank: 2,  displayName: 'The Dali Llama Himself', totalScore: -75, tournamentsPlayed: 3, isMe: true  },
    { rank: 3,  displayName: 'Marge',                  totalScore: -72, tournamentsPlayed: 3, isMe: false },
  ],
  siteUrl:        'https://fairway.golf-czar.com',
  corrected:      true,
});

writeFileSync('/tmp/preview-corrected.html', out.html);
writeFileSync('/tmp/preview-corrected.txt', out.text);
console.log('Subject:', out.subject);
console.log();
console.log('--- TEXT ---');
console.log(out.text);
console.log();
console.log('HTML written to /tmp/preview-corrected.html');
