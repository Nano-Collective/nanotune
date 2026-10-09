import {StatusMessage} from '@inkjs/ui';
import {Box, Text} from 'ink';
import type {TrainingProgress} from '../types/index.js';
import {ExitHint} from './ExitHint.js';

export function TrainingDone({progress}: {progress: TrainingProgress | null}) {
	const unfinished = progress?.earlyStopped && !progress.restoredBest;
	return (
		<Box flexDirection="column">
			<StatusMessage variant={unfinished ? 'warning' : 'success'}>
				{progress?.earlyStopped ? 'Stopped early' : 'Training complete!'}
			</StatusMessage>
			<Text> </Text>
			{progress?.earlyStopped && (
				<Text>Validation loss stopped improving.</Text>
			)}
			{progress?.restoredBest &&
				progress.bestIteration != null &&
				progress.bestValLoss != null && (
					<Text>
						Restored checkpoint at iteration{' '}
						<Text color="cyan">{progress.bestIteration}</Text> (val loss{' '}
						<Text color="green">{progress.bestValLoss.toFixed(4)}</Text>)
					</Text>
				)}
			{unfinished && (
				<Text>
					No finite validation checkpoint was selected. The last saved adapter
					was kept.
				</Text>
			)}
			{!progress?.restoredBest &&
				!progress?.earlyStopped &&
				progress?.trainLoss != null && (
					<Text>
						Final loss:{' '}
						<Text color="green">{progress.trainLoss.toFixed(4)}</Text>
					</Text>
				)}
			{!unfinished && (
				<>
					<Text> </Text>
					<Text>
						Next: <Text color="cyan">nanotune export</Text>
					</Text>
				</>
			)}
			<Text> </Text>
			<ExitHint>Press any key to exit</ExitHint>
		</Box>
	);
}
